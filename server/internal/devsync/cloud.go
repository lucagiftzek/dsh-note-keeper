package devsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// CloudConfig is the user-facing cloud mirror setting.
type CloudConfig struct {
	Enabled     bool   `json:"enabled"`
	Remote      string `json:"remote"` // rclone remote name with colon, e.g. "gdrive:"
	Path        string `json:"path"`   // folder inside the remote, e.g. "NoteKeeper"
	IntervalMin int    `json:"intervalMin"`
}

// CloudState is CloudConfig plus run bookkeeping.
type CloudState struct {
	CloudConfig
	Resynced  bool   `json:"resynced"`
	Running   bool   `json:"running"`
	LastRun   int64  `json:"lastRun,omitempty"`
	LastOK    bool   `json:"lastOk"`
	LastError string `json:"lastError,omitempty"`
	Log       string `json:"log,omitempty"`
}

// Remote is one configured rclone remote.
type Remote struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

var (
	remoteRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.\- ]*:$`)
	pathRe   = regexp.MustCompile(`^[^\x00-\x1f]*$`)
)

// cloudRunner runs rclone bisync between the vault and a remote on an interval.
type cloudRunner struct {
	s       *Service
	file    string
	mu      sync.Mutex
	st      CloudState
	trigger chan struct{}
}

func newCloudRunner(s *Service, file string) *cloudRunner {
	c := &cloudRunner{s: s, file: file, trigger: make(chan struct{}, 1)}
	if b, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(b, &c.st)
	}
	c.st.Running = false
	return c
}

func (c *cloudRunner) state() CloudState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.st
}

func (c *cloudRunner) saveLocked() {
	b, _ := json.MarshalIndent(c.st, "", "  ")
	tmp := c.file + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, c.file)
	}
}

func (s *Service) rclone() string {
	if s.cfg.Rclone != "" {
		return s.cfg.Rclone
	}
	return "rclone"
}

// Remotes lists configured rclone remotes (empty when rclone is missing).
func (s *Service) Remotes(ctx context.Context) ([]Remote, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, s.rclone(), "listremotes", "--long").Output()
	if err != nil {
		var ee *exec.Error
		if errors.As(err, &ee) {
			return []Remote{}, nil
		}
		return nil, err
	}
	res := []Remote{}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && strings.HasSuffix(f[0], ":") {
			res = append(res, Remote{Name: f[0], Type: f[1]})
		}
	}
	return res, nil
}

// CloudState returns the mirror state.
func (s *Service) CloudState() CloudState { return s.cloud.state() }

// SetCloud validates and stores a new cloud configuration. Changing the
// remote or path resets the bisync baseline (next run is a --resync merge).
func (s *Service) SetCloud(ctx context.Context, cfg CloudConfig) (CloudState, error) {
	cfg.Path = strings.TrimRight(strings.TrimSpace(cfg.Path), "/")
	if cfg.IntervalMin <= 0 {
		cfg.IntervalMin = 10
	}
	if cfg.IntervalMin < 2 {
		cfg.IntervalMin = 2
	}
	if cfg.Enabled || cfg.Remote != "" {
		if !remoteRe.MatchString(cfg.Remote) || !pathRe.MatchString(cfg.Path) || strings.Contains(cfg.Path, "..") {
			return CloudState{}, errors.New("invalid remote or path")
		}
		rs, err := s.Remotes(ctx)
		if err != nil {
			return CloudState{}, err
		}
		found := false
		for _, r := range rs {
			found = found || r.Name == cfg.Remote
		}
		if !found {
			return CloudState{}, errors.New("unknown rclone remote " + cfg.Remote + " (configure it with: rclone config)")
		}
	}
	c := s.cloud
	c.mu.Lock()
	if c.st.Remote != cfg.Remote || c.st.Path != cfg.Path {
		c.st.Resynced = false
	}
	c.st.CloudConfig = cfg
	c.saveLocked()
	st := c.st
	c.mu.Unlock()
	if cfg.Enabled {
		c.kick()
	}
	return st, nil
}

// RunCloud asks for an immediate mirror run.
func (s *Service) RunCloud() { s.cloud.kick() }

func (c *cloudRunner) kick() {
	select {
	case c.trigger <- struct{}{}:
	default:
	}
}

// StartCloud runs the mirror loop until ctx ends.
func (s *Service) StartCloud(ctx context.Context) {
	c := s.cloud
	go func() {
		for {
			st := c.state()
			wait := time.Duration(st.IntervalMin) * time.Minute
			if wait <= 0 {
				wait = 10 * time.Minute
			}
			t := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-c.trigger:
			case <-t.C:
			}
			t.Stop()
			if c.state().Enabled {
				c.run(ctx)
			}
		}
	}()
}

func (c *cloudRunner) run(parent context.Context) {
	c.mu.Lock()
	if c.st.Running {
		c.mu.Unlock()
		return
	}
	c.st.Running = true
	cfg, resynced := c.st.CloudConfig, c.st.Resynced
	c.mu.Unlock()

	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	defer cancel()
	dst := cfg.Remote + cfg.Path
	var out bytes.Buffer
	var err error
	if !resynced {
		cmd := exec.CommandContext(ctx, c.s.rclone(), "mkdir", dst)
		cmd.Stdout, cmd.Stderr = &out, &out
		err = cmd.Run()
	}
	if err == nil {
		args := []string{"bisync", c.s.v.Root(), dst,
			"--create-empty-src-dirs", "--compare", "size,modtime", "--resilient", "--recover",
			"--max-lock", "2m", "--conflict-resolve", "newer", "--conflict-loser", "num",
			"--exclude", ".obsidian/**", "--exclude", ".trash/**", "--exclude", ".git/**",
			"--exclude", ".nk-tmp-*", "--exclude", ".DS_Store", "-v"}
		if !resynced {
			args = append(args, "--resync")
		}
		cmd := exec.CommandContext(ctx, c.s.rclone(), args...)
		cmd.Stdout, cmd.Stderr = &out, &out
		err = cmd.Run()
	}
	log := out.String()
	if len(log) > 8000 {
		log = "…" + log[len(log)-8000:]
	}
	c.mu.Lock()
	c.st.Running = false
	c.st.LastRun = c.s.cfg.Now().UnixMilli()
	c.st.Log = log
	c.st.LastOK = err == nil
	if err != nil {
		c.st.LastError = err.Error()
		// A bisync that lost its baseline needs a fresh --resync.
		if strings.Contains(log, "--resync") && strings.Contains(strings.ToLower(log), "must run") {
			c.st.Resynced = false
		}
	} else {
		c.st.LastError = ""
		c.st.Resynced = true
	}
	c.saveLocked()
	c.mu.Unlock()
	c.s.Invalidate()
	if err != nil {
		c.s.cfg.Logf("devsync: cloud mirror %s failed: %v", dst, err)
	} else {
		c.s.cfg.Logf("devsync: cloud mirror %s ok", dst)
	}
}
