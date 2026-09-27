package api

import (
	"errors"
	"net/http"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/devsync"
)

// Admin endpoints for remote devices: pairing codes, WebDAV app passwords,
// device revocation and the rclone cloud mirror. All of them are local-only.

func (s *Server) syncSvc(w http.ResponseWriter) *devsync.Service {
	if s.cfg.Sync == nil {
		writeErr(w, http.StatusServiceUnavailable, "sync_off", errors.New("remote sync is not enabled on this server"))
	}
	return s.cfg.Sync
}

func (s *Server) syncStatus(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Sync == nil {
		writeJSON(w, 200, map[string]any{"enabled": false, "devices": []any{}})
		return
	}
	writeJSON(w, 200, s.cfg.Sync.Status(s.cfg.SyncListening))
}

func (s *Server) syncPair(w http.ResponseWriter, r *http.Request) {
	if svc := s.syncSvc(w); svc != nil {
		writeJSON(w, 200, svc.NewPairing())
	}
}

func (s *Server) syncRevoke(w http.ResponseWriter, r *http.Request) {
	svc := s.syncSvc(w)
	if svc == nil {
		return
	}
	ok, err := svc.Store().Revoke(r.URL.Query().Get("id"))
	if err != nil {
		fail(w, err)
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", errors.New("no such device"))
		return
	}
	writeJSON(w, 200, map[string]any{"revoked": true})
}

func (s *Server) syncWebDAV(w http.ResponseWriter, r *http.Request) {
	svc := s.syncSvc(w)
	if svc == nil {
		return
	}
	var req struct{ Name string }
	_ = decode(r, &req)
	out, err := svc.NewWebDAV(req.Name)
	if err != nil {
		writeErr(w, 400, "webdav", err)
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) syncRemotes(w http.ResponseWriter, r *http.Request) {
	svc := s.syncSvc(w)
	if svc == nil {
		return
	}
	rs, err := svc.Remotes(r.Context())
	if err != nil {
		writeErr(w, 500, "rclone", err)
		return
	}
	writeJSON(w, 200, map[string]any{"remotes": rs, "cloud": svc.CloudState()})
}

func (s *Server) syncSetCloud(w http.ResponseWriter, r *http.Request) {
	svc := s.syncSvc(w)
	if svc == nil {
		return
	}
	var cfg devsync.CloudConfig
	if err := decode(r, &cfg); err != nil {
		fail(w, err)
		return
	}
	st, err := svc.SetCloud(r.Context(), cfg)
	if err != nil {
		writeErr(w, 400, "cloud", err)
		return
	}
	writeJSON(w, 200, st)
}

func (s *Server) syncRunCloud(w http.ResponseWriter, r *http.Request) {
	if svc := s.syncSvc(w); svc != nil {
		svc.RunCloud()
		writeJSON(w, 202, map[string]any{"started": true})
	}
}
