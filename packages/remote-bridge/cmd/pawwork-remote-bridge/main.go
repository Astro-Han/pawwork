package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/astro-han/pawwork/packages/remote-bridge/internal/gateway"
	"github.com/astro-han/pawwork/packages/remote-bridge/internal/platforms"
)

func main() {
	configPath := flag.String("config", "", "Path to the remote bridge JSON config. Use - to read from stdin.")
	listPlatforms := flag.Bool("list-platforms", false, "Print registered cc-connect platforms as JSON.")
	flag.Parse()

	if *listPlatforms {
		if err := json.NewEncoder(os.Stdout).Encode(platforms.Available()); err != nil {
			exit(err)
		}
		return
	}
	if *configPath == "" {
		exit(fmt.Errorf("-config is required"))
	}
	var config gateway.Config
	var err error
	if *configPath == "-" {
		config, err = gateway.DecodeConfig(os.Stdin)
	} else {
		config, err = gateway.LoadConfig(*configPath)
	}
	if err != nil {
		exit(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := gateway.Run(ctx, config); err != nil {
		exit(err)
	}
}

func exit(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
