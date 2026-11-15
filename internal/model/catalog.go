// Package model describes Bergamot language-pair packs served from local disk.
package model

import (
	"encoding/json"
	"fmt"
	"math"
	"path"
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
	"af":      "Afrikaans",
	"ar":      "Arabic",
	"az":      "Azerbaijani",
	"be":      "Belarusian",
	"bg":      "Bulgarian",
	"bn":      "Bengali",
	"bs":      "Bosnian",
	"ca":      "Catalan",
	"cs":      "Czech",
	"da":      "Danish",
	"de":      "German",
	"el":      "Greek",
	"en":      "English",
	"es":      "Spanish",
	"et":      "Estonian",
	"eu":      "Basque",
	"fa":      "Persian",
	"fi":      "Finnish",
	"fr":      "French",
	"gl":      "Galician",
	"gu":      "Gujarati",
	"he":      "Hebrew",
	"hi":      "Hindi",
	"hr":      "Croatian",
	"hu":      "Hungarian",
	"id":      "Indonesian",
	"is":      "Icelandic",
	"it":      "Italian",
	"ja":      "Japanese",
	"kn":      "Kannada",
	"ko":      "Korean",
	"lt":      "Lithuanian",
	"lv":      "Latvian",
	"ml":      "Malayalam",
	"mr":      "Marathi",
	"ms":      "Malay",
	"mt":      "Maltese",
	"nb":      "Norwegian Bokmål",
	"nl":      "Dutch",
	"nn":      "Norwegian Nynorsk",
	"pl":      "Polish",
	"pt":      "Portuguese",
	"ro":      "Romanian",
	"ru":      "Russian",
	"sk":      "Slovak",
	"sl":      "Slovenian",
	"sq":      "Albanian",
	"sr":      "Serbian",
	"sv":      "Swedish",
	"ta":      "Tamil",
	"te":      "Telugu",
	"th":      "Thai",
	"tl":      "Tagalog",
	"tr":      "Turkish",
	"ug":      "Uyghur",
	"uk":      "Ukrainian",
	"ur":      "Urdu",
	"vi":      "Vietnamese",
	"zh":      "Chinese",
	"zh-hant": "Chinese (Traditional)",
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
	{from: "en", to: "zh", sizeMB: 40, notes: "Firefox EN-ZH (needs Bergamot WASM 2.x)"},
	{from: "zh", to: "en", sizeMB: 40, notes: "Firefox ZH-EN (needs Bergamot WASM 2.x)"},
	{from: "en", to: "ja", sizeMB: 40, notes: "Firefox EN-JA (needs Bergamot WASM 2.x)"},
	{from: "ja", to: "en", sizeMB: 40, notes: "Firefox JA-EN (needs Bergamot WASM 2.x)"},
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

// registryEntry mirrors one pair in web/models/registry.json as written by
// scripts/fetch-assets.sh. Only the fields the catalog needs are decoded.
type registryEntry struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Model struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	} `json:"model"`
	Lex struct {
		Size int64 `json:"size"`
	} `json:"lex"`
	Vocab    fileSize `json:"vocab"`
	SrcVocab fileSize `json:"srcvocab"`
	TrgVocab fileSize `json:"trgvocab"`
}

type fileSize struct {
	Size int64 `json:"size"`
}

// CatalogFromRegistry builds a Catalog from a models/registry.json document so
// the advertised pairs always match the packs actually on disk.
func CatalogFromRegistry(data []byte) (Catalog, error) {
	var raw map[string]registryEntry
	if err := json.Unmarshal(data, &raw); err != nil {
		return Catalog{}, fmt.Errorf("registry: %w", err)
	}
	pairs := make([]string, 0, len(raw))
	for key := range raw {
		pairs = append(pairs, key)
	}
	slices.Sort(pairs)

	models := make([]Model, 0, len(pairs))
	langs := map[string]bool{}
	defaultIdx, firstEnIdx := -1, -1
	for i, key := range pairs {
		entry := raw[key]
		from, to := entry.From, entry.To
		if from == "" || to == "" {
			from, to = key[:2], key[2:]
		}
		modelName := entry.Model.Name
		dir := path.Dir(modelName)
		tier := "tiny"
		if strings.HasPrefix(dir, "/models/hq/") {
			tier = "hq"
		}
		total := entry.Model.Size + entry.Lex.Size + entry.Vocab.Size + entry.SrcVocab.Size + entry.TrgVocab.Size
		fromLabel := languageLabels[from]
		if fromLabel == "" {
			fromLabel = from
		}
		toLabel := languageLabels[to]
		if toLabel == "" {
			toLabel = to
		}
		models = append(models, Model{
			ID:           tier + "-" + key,
			Label:        fromLabel + " to " + toLabel,
			Engine:       EngineBergamot,
			Path:         dir,
			From:         from,
			To:           to,
			Architecture: tier,
			SizeHintMB:   math.Round(float64(total)/1048576*10) / 10,
			SpeedRank:    4,
			AccuracyRank: 4,
		})
		langs[from] = true
		langs[to] = true
		if from == "en" {
			if firstEnIdx < 0 {
				firstEnIdx = i
			}
			if to == "es" {
				defaultIdx = i
			}
		}
	}
	if len(models) == 0 {
		return Catalog{}, fmt.Errorf("registry: no pairs")
	}
	if defaultIdx < 0 {
		defaultIdx = firstEnIdx
	}
	if defaultIdx < 0 {
		defaultIdx = 0
	}
	models[defaultIdx].Default = true
	return Catalog{
		Models:    models,
		Languages: languagesFor(langs),
		Pivot:     "en",
	}, nil
}

// languagesFor returns sorted Language entries (English first) for the given
// set of codes, falling back to the code itself when unlabeled.
func languagesFor(codes map[string]bool) []Language {
	list := make([]string, 0, len(codes))
	for code := range codes {
		list = append(list, code)
	}
	slices.SortFunc(list, func(a, b string) int {
		return strings.Compare(languageLabels[a], languageLabels[b])
	})
	out := make([]Language, 0, len(list)+1)
	if codes["en"] {
		out = append(out, Language{Code: "en", Label: languageLabels["en"]})
	}
	for _, code := range list {
		if code == "en" {
			continue
		}
		label := languageLabels[code]
		if label == "" {
			label = code
		}
		out = append(out, Language{Code: code, Label: label})
	}
	return out
}
