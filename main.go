package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// flushWriter writes to w and calls Sync after each Write so console output
// is visible when the app is double-clicked on Windows or run from terminal.
type flushWriter struct{ w *os.File }

func (f flushWriter) Write(p []byte) (n int, err error) {
	n, err = f.w.Write(p)
	if err == nil {
		f.w.Sync()
	}
	return n, err
}

func main() {
	// Print to stdout immediately so something appears in the terminal no matter what
	fmt.Println("Satisflow starting...")
	os.Stdout.Sync()

	// Use executable's directory so double-click works and finds index.html
	dir := "."
	if exe, err := os.Executable(); err == nil {
		dir = filepath.Dir(exe)
	}

	// Log to stdout and server.log (stdout only = no duplicate lines in terminal)
	logFile, _ := os.Create(filepath.Join(dir, "server.log"))
	console := flushWriter{os.Stdout}
	if logFile != nil {
		defer logFile.Close()
		log.SetOutput(io.MultiWriter(console, logFile))
	} else {
		log.SetOutput(console)
	}
	log.SetFlags(log.Ltime)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			p := filepath.Join(dir, r.URL.Path)
			if _, err := os.Stat(p); err == nil {
				http.ServeFile(w, r, p)
				return
			}
		}
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})

	// Log each request
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		handler.ServeHTTP(w, r)
	}))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := ":" + port

	log.Println("----------------------------------------")
	log.Println("  Satisflow server")
	log.Println("  http://localhost" + addr)
	log.Println("----------------------------------------")
	log.Println("Ready. Press Ctrl+C to stop.")

	if err := http.ListenAndServe(addr, nil); err != nil {
		if strings.Contains(err.Error(), "bind") || strings.Contains(err.Error(), "address already in use") {
			log.Printf("Port %s is already in use. Stop the other process or set PORT=8081", port)
		}
		log.Fatal(err)
	}
}
