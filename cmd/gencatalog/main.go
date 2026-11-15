// Command gencatalog writes the public model catalog as JSON for static hosting.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Quad4-Software/translatasm/internal/model"
)

func main() {
	out := flag.String("o", "web/catalog.json", "output path")
	reg := flag.String("registry", "web/models/registry.json", "models registry path (optional)")
	flag.Parse()

	catalog := model.DefaultCatalog()
	if data, err := os.ReadFile(*reg); err == nil {
		if c, err := model.CatalogFromRegistry(data); err == nil {
			catalog = c
		} else {
			fmt.Fprintf(os.Stderr, "warning: %v; using default catalog\n", err)
		}
	}

	data, err := json.MarshalIndent(catalog, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal: %v\n", err)
		os.Exit(1)
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "mkdir: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, data, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "write: %v\n", err)
		os.Exit(1)
	}
}
