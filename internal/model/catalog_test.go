package model_test

import (
	"strings"
	"testing"

	"github.com/Quad4-Software/translatasm/internal/model"
)

func TestDefaultCatalog(t *testing.T) {
	t.Parallel()
	c := model.DefaultCatalog()
	if len(c.Models) < 50 {
		t.Fatalf("expected expanded Bergamot set, got %d", len(c.Models))
	}
	if len(c.Languages) < 25 {
		t.Fatalf("languages=%d", len(c.Languages))
	}
	if c.Pivot != "en" {
		t.Fatalf("pivot=%q", c.Pivot)
	}
	def, ok := c.DefaultModel()
	if !ok || !def.Default {
		t.Fatalf("missing default model: %+v", def)
	}
	if def.Engine != model.EngineBergamot {
		t.Fatalf("engine=%s", def.Engine)
	}
	if def.From == "" || def.To == "" {
		t.Fatalf("missing language pair: %+v", def)
	}
	if !strings.HasPrefix(def.Path, "/models/") {
		t.Fatalf("path=%s", def.Path)
	}
	got, ok := c.ByID(def.ID)
	if !ok || got.Path == "" {
		t.Fatalf("by id failed: %+v", got)
	}
	pair, ok := c.ByPair("fr", "en")
	if !ok || pair.From != "fr" {
		t.Fatalf("by pair failed: %+v", pair)
	}
	ids := c.IDs()
	if len(ids) != len(c.Models) {
		t.Fatalf("ids len %d", len(ids))
	}
}

func TestByIDMissing(t *testing.T) {
	t.Parallel()
	_, ok := model.DefaultCatalog().ByID("nope")
	if ok {
		t.Fatal("expected miss")
	}
}

func TestLanguagesEnglishFirst(t *testing.T) {
	t.Parallel()
	langs := model.DefaultLanguages()
	if langs[0].Code != "en" {
		t.Fatalf("first=%s", langs[0].Code)
	}
}
