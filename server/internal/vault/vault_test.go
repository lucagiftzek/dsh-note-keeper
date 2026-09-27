package vault

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func newVault(t *testing.T) *Vault {
	t.Helper()
	v, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestCleanRejectsEscapes(t *testing.T) {
	bad := []string{"", "..", "../x.md", "a/../../x", "a/../b", ".obsidian/app.json", "a/.trash/x.md", "a\\b.md", "x\x00.md", ".nk-lock.json"}
	for _, p := range bad {
		if _, err := Clean(p, false); !errors.Is(err, ErrBadPath) {
			t.Errorf("Clean(%q) = %v, want ErrBadPath", p, err)
		}
	}
	good := map[string]string{"a.md": "a.md", "/a/b.md": "a/b.md", "a//b.md": "a/b.md", " x/y.md ": "x/y.md", "Ελληνικά/σημείωση.md": "Ελληνικά/σημείωση.md"}
	for in, want := range good {
		got, err := Clean(in, false)
		if err != nil || got != want {
			t.Errorf("Clean(%q) = %q,%v want %q", in, got, err, want)
		}
	}
	if c, err := Clean("", true); err != nil || c != "" {
		t.Errorf("root not allowed: %q %v", c, err)
	}
}

func TestSymlinkEscapeBlocked(t *testing.T) {
	v := newVault(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(v.Root(), "link")); err != nil {
		t.Skip("symlinks unsupported")
	}
	if _, err := v.Write("link/evil.md", []byte("x"), WriteOpts{}); !errors.Is(err, ErrBadPath) {
		t.Fatalf("write through symlink: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "evil.md")); err == nil {
		t.Fatal("file escaped the vault")
	}
}

func TestWriteReadConflictCreate(t *testing.T) {
	v := newVault(t)
	m1, err := v.Write("n/a.md", []byte("one"), WriteOpts{Create: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Write("n/a.md", []byte("x"), WriteOpts{Create: true}); !errors.Is(err, ErrExists) {
		t.Fatalf("create twice: %v", err)
	}
	b, m, err := v.Read("n/a.md", 0)
	if err != nil || string(b) != "one" || m != m1 {
		t.Fatalf("read: %q %d %v", b, m, err)
	}
	if _, err := v.Write("n/a.md", []byte("two"), WriteOpts{BaseMtime: m1 - 5}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale base mtime accepted: %v", err)
	}
	if _, err := v.Write("n/a.md", []byte("two"), WriteOpts{BaseMtime: m1}); err != nil {
		t.Fatalf("fresh base mtime rejected: %v", err)
	}
	if _, _, err := v.Read("n/a.md", 2); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("size cap: %v", err)
	}
	// No temp files left behind.
	ents, _ := os.ReadDir(filepath.Join(v.Root(), "n"))
	if len(ents) != 1 {
		t.Fatalf("leftover files: %v", ents)
	}
}

func TestLockedFolderRefusesPlaintext(t *testing.T) {
	v := newVault(t)
	if err := v.Mkdir("secret/sub"); err != nil {
		t.Fatal(err)
	}
	if err := v.WriteLockMarker("secret", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if got := v.LockedScope("secret/sub/x.md"); got != "secret" {
		t.Fatalf("scope %q", got)
	}
	if _, err := v.Write("secret/sub/x.md", []byte("plain"), WriteOpts{}); !errors.Is(err, ErrLocked) {
		t.Fatalf("plaintext accepted in locked folder: %v", err)
	}
	if _, err := v.Write("secret/sub/x.md", []byte("env"), WriteOpts{Encrypted: true}); err != nil {
		t.Fatalf("envelope refused: %v", err)
	}
	if _, err := v.Write("open.md", []byte("p"), WriteOpts{}); err != nil {
		t.Fatal(err)
	}
	if err := v.Move("open.md", "secret/open.md"); !errors.Is(err, ErrLocked) {
		t.Fatalf("plaintext moved into locked folder: %v", err)
	}
	if got := v.LockedFolders(); len(got) != 1 || got[0] != "secret" {
		t.Fatalf("locked folders %v", got)
	}
	// The lock marker never shows up in listings.
	list, _ := v.List()
	for _, e := range list {
		if filepath.Base(e.Path) == LockMarker {
			t.Fatal("marker listed")
		}
	}
}

func TestMoveTrashUnique(t *testing.T) {
	v := newVault(t)
	_, _ = v.Write("a.md", []byte("a"), WriteOpts{})
	_, _ = v.Write("b.md", []byte("b"), WriteOpts{})
	if err := v.Move("a.md", "b.md"); !errors.Is(err, ErrExists) {
		t.Fatalf("overwrite on move: %v", err)
	}
	if err := v.Mkdir("f"); err != nil {
		t.Fatal(err)
	}
	if err := v.Move("f", "f/g"); !errors.Is(err, ErrBadPath) {
		t.Fatalf("folder into itself: %v", err)
	}
	if err := v.Move("a.md", "f/a2.md"); err != nil {
		t.Fatal(err)
	}
	u, _ := v.UniquePath("b.md")
	if u != "b 1.md" {
		t.Fatalf("unique %q", u)
	}
	dst, err := v.Trash("b.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), filepath.FromSlash(dst))); err != nil {
		t.Fatalf("trash target missing: %v", err)
	}
	list, _ := v.List()
	for _, e := range list {
		if e.Path == "b.md" || filepath.Base(filepath.Dir(e.Path)) == ".trash" {
			t.Fatalf("trashed file still listed: %v", e.Path)
		}
	}
}
