// Command gencatalog writes the public model catalog as JSON for static hosting.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/Quad4-Software/translatasm/internal/model"
)

func main() {
	out := flag.String("o", "web/catalog.json", "output path")
	flag.Parse()

	data, err := json.MarshalIndent(model.DefaultCatalog(), "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal: %v\n", err)
		os.Exit(1)
	}
	data = append(data, '\n')
	if err := os.WriteFile(*out, data, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "write: %v\n", err)
		os.Exit(1)
	}
}
