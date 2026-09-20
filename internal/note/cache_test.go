package note

import "testing"

func TestCacheIsBounded(t *testing.T) {
	c := NewCache()
	for i := 0; i < maxCachedNotes+1; i++ {
		c.Set(string(rune('a'+i)), "content")
	}
	if c.lru.Len() != maxCachedNotes {
		t.Fatalf("cache length = %d, want %d", c.lru.Len(), maxCachedNotes)
	}
	if _, ok := c.Get("a"); ok {
		t.Fatal("least-recently-used entry was not evicted")
	}
	large := make([]byte, maxCacheBytes+1)
	c.Set("large", string(large))
	if _, ok := c.Get("large"); ok {
		t.Fatal("oversized cache entry was retained")
	}
}
