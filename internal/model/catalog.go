// Package model describes Bergamot language-pair packs served from local disk.
package model

import (
	"slices"
	"strings"
)

// Engine identifies a browser translation backend.
type Engine string

const (
	// EngineBergamot runs Marian NMT via the Bergamot WASM worker.
	EngineBergamot Engine = "bergamot"
)

// Language is a selectable UI language.
type Language struct {
	Code  string `json:"code"`
	Label string `json:"label"`
}

// Model is a bilingual translation pack.
type Model struct {
	ID           string  `json:"id"`
	Label        string  `json:"label"`
	Engine       Engine  `json:"engine"`
	Path         string  `json:"path"`
	From         string  `json:"from"`
	To           string  `json:"to"`
	Architecture string  `json:"architecture"`
	SizeHintMB   float64 `json:"size_hint_mb"`
	SpeedRank    int     `json:"speed_rank"`
	AccuracyRank int     `json:"accuracy_rank"`
	Default      bool    `json:"default,omitempty"`
	Notes        string  `json:"notes,omitempty"`
}

// Catalog is the ordered list of models exposed by the API.
type Catalog struct {
	Models    []Model    `json:"models"`
	Languages []Language `json:"languages"`
	Pivot     string     `json:"pivot"`
}

type pairSpec struct {
	from   string
	to     string
	sizeMB float64
	notes  string
}

var languageLabels = map[string]string{
	"bg": "Bulgarian",
	"ca": "Catalan",
	"cs": "Czech",
	"da": "Danish",
	"de": "German",
	"el": "Greek",
	"en": "English",
	"es": "Spanish",
	"et": "Estonian",
	"fi": "Finnish",
	"fr": "French",
	"hr": "Croatian",
	"hu": "Hungarian",
	"id": "Indonesian",
	"it": "Italian",
	"nb": "Norwegian",
	"nl": "Dutch",
	"pl": "Polish",
	"pt": "Portuguese",
	"ro": "Romanian",
	"ru": "Russian",
	"sk": "Slovak",
	"sl": "Slovenian",
	"sv": "Swedish",
	"tr": "Turkish",
	"uk": "Ukrainian",
	"vi": "Vietnamese",
}

// Bergamot S3 tiny packs plus curated Firefox Translations extras.
var allPairs = []pairSpec{
	{from: "en", to: "es", sizeMB: 17, notes: "Tiny EN-ES"},
	{from: "es", to: "en", sizeMB: 17, notes: "Tiny ES-EN"},
	{from: "en", to: "fr", sizeMB: 17, notes: "Tiny EN-FR"},
	{from: "fr", to: "en", sizeMB: 17, notes: "Tiny FR-EN"},
	{from: "en", to: "de", sizeMB: 17, notes: "Tiny EN-DE"},
	{from: "de", to: "en", sizeMB: 17, notes: "Tiny DE-EN"},
	{from: "en", to: "it", sizeMB: 17, notes: "Tiny EN-IT"},
	{from: "it", to: "en", sizeMB: 17, notes: "Tiny IT-EN"},
	{from: "en", to: "pt", sizeMB: 17, notes: "Tiny EN-PT"},
	{from: "pt", to: "en", sizeMB: 17, notes: "Tiny PT-EN"},
	{from: "en", to: "ru", sizeMB: 17, notes: "Tiny EN-RU"},
	{from: "ru", to: "en", sizeMB: 17, notes: "Tiny RU-EN"},
	{from: "en", to: "cs", sizeMB: 17, notes: "Tiny EN-CS"},
	{from: "cs", to: "en", sizeMB: 17, notes: "Tiny CS-EN"},
	{from: "en", to: "bg", sizeMB: 17, notes: "Tiny EN-BG"},
	{from: "bg", to: "en", sizeMB: 17, notes: "Tiny BG-EN"},
	{from: "en", to: "et", sizeMB: 17, notes: "Tiny EN-ET"},
	{from: "et", to: "en", sizeMB: 17, notes: "Tiny ET-EN"},
	{from: "en", to: "uk", sizeMB: 25, notes: "UK pack (intgemm8)"},
	{from: "uk", to: "en", sizeMB: 25, notes: "UK pack (intgemm8)"},
	{from: "en", to: "pl", sizeMB: 22, notes: "Firefox EN-PL"},
	{from: "pl", to: "en", sizeMB: 23, notes: "Firefox PL-EN"},
	{from: "en", to: "nl", sizeMB: 22, notes: "Firefox EN-NL"},
	{from: "nl", to: "en", sizeMB: 23, notes: "Firefox NL-EN"},
	{from: "en", to: "sv", sizeMB: 22, notes: "Firefox EN-SV"},
	{from: "sv", to: "en", sizeMB: 23, notes: "Firefox SV-EN"},
	{from: "en", to: "da", sizeMB: 22, notes: "Firefox EN-DA"},
	{from: "da", to: "en", sizeMB: 22, notes: "Firefox DA-EN"},
	{from: "en", to: "fi", sizeMB: 21, notes: "Firefox EN-FI"},
	{from: "fi", to: "en", sizeMB: 23, notes: "Firefox FI-EN"},
	{from: "en", to: "hu", sizeMB: 22, notes: "Firefox EN-HU"},
	{from: "hu", to: "en", sizeMB: 23, notes: "Firefox HU-EN"},
	{from: "en", to: "ro", sizeMB: 22, notes: "Firefox EN-RO"},
	{from: "ro", to: "en", sizeMB: 23, notes: "Firefox RO-EN"},
	{from: "en", to: "el", sizeMB: 21, notes: "Firefox EN-EL"},
	{from: "el", to: "en", sizeMB: 23, notes: "Firefox EL-EN"},
	{from: "en", to: "tr", sizeMB: 21, notes: "Firefox EN-TR"},
	{from: "tr", to: "en", sizeMB: 23, notes: "Firefox TR-EN"},
	{from: "en", to: "ca", sizeMB: 22, notes: "Firefox EN-CA"},
	{from: "ca", to: "en", sizeMB: 23, notes: "Firefox CA-EN"},
	{from: "en", to: "hr", sizeMB: 21, notes: "Firefox EN-HR"},
	{from: "hr", to: "en", sizeMB: 22, notes: "Firefox HR-EN"},
	{from: "en", to: "sk", sizeMB: 21, notes: "Firefox EN-SK"},
	{from: "sk", to: "en", sizeMB: 23, notes: "Firefox SK-EN"},
	{from: "en", to: "sl", sizeMB: 21, notes: "Firefox EN-SL"},
	{from: "sl", to: "en", sizeMB: 22, notes: "Firefox SL-EN"},
	{from: "en", to: "id", sizeMB: 21, notes: "Firefox EN-ID"},
	{from: "id", to: "en", sizeMB: 22, notes: "Firefox ID-EN"},
	{from: "en", to: "vi", sizeMB: 22, notes: "Firefox EN-VI"},
	{from: "vi", to: "en", sizeMB: 22, notes: "Firefox VI-EN"},
	{from: "en", to: "nb", sizeMB: 22, notes: "Firefox EN-NB"},
	{from: "nb", to: "en", sizeMB: 15, notes: "Firefox NB-EN"},
}

// DefaultCatalog returns every Bergamot pack plus language metadata.
func DefaultCatalog() Catalog {
	models := make([]Model, 0, len(allPairs))
	for i, p := range allPairs {
		pair := p.from + p.to
		fromLabel := languageLabels[p.from]
		toLabel := languageLabels[p.to]
		models = append(models, Model{
			ID:           "tiny-" + pair,
			Label:        fromLabel + " to " + toLabel,
			Engine:       EngineBergamot,
			Path:         "/models/tiny/" + pair,
			From:         p.from,
			To:           p.to,
			Architecture: "tiny",
			SizeHintMB:   p.sizeMB,
			SpeedRank:    5,
			AccuracyRank: 3,
			Default:      i == 0,
			Notes:        p.notes,
		})
	}
	return Catalog{
		Models:    models,
		Languages: DefaultLanguages(),
		Pivot:     "en",
	}
}

// DefaultLanguages returns UI languages sorted with English first.
func DefaultLanguages() []Language {
	codes := make([]string, 0, len(languageLabels))
	for code := range languageLabels {
		if code == "en" {
			continue
		}
		codes = append(codes, code)
	}
	slices.SortFunc(codes, func(a, b string) int {
		return strings.Compare(languageLabels[a], languageLabels[b])
	})
	out := make([]Language, 0, len(codes)+1)
	out = append(out, Language{Code: "en", Label: languageLabels["en"]})
	for _, code := range codes {
		out = append(out, Language{Code: code, Label: languageLabels[code]})
	}
	return out
}

// ByID returns a model or false when unknown.
func (c Catalog) ByID(id string) (Model, bool) {
	for i := range c.Models {
		if c.Models[i].ID == id {
			return c.Models[i], true
		}
	}
	return Model{}, false
}

// ByPair returns a direct pack for from->to.
func (c Catalog) ByPair(from, to string) (Model, bool) {
	for i := range c.Models {
		if c.Models[i].From == from && c.Models[i].To == to {
			return c.Models[i], true
		}
	}
	return Model{}, false
}

// DefaultModel returns the catalog default or the first entry.
func (c Catalog) DefaultModel() (Model, bool) {
	for i := range c.Models {
		if c.Models[i].Default {
			return c.Models[i], true
		}
	}
	if len(c.Models) == 0 {
		return Model{}, false
	}
	return c.Models[0], true
}

// IDs returns model identifiers in catalog order.
func (c Catalog) IDs() []string {
	ids := make([]string, 0, len(c.Models))
	for i := range c.Models {
		ids = append(ids, c.Models[i].ID)
	}
	return slices.Clone(ids)
}
