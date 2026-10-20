package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"unicode/utf8"
)

func wizardArgs(ctx context.Context, console startupConsole) ([]string, error) {
	return wizardArgsForPlatform(ctx, console, runtime.GOOS)
}
func wizardArgsForPlatform(ctx context.Context, console startupConsole, platform string) ([]string, error) {
	ask := func(prompt, fallback string) (string, error) {
		if fallback != "" {
			prompt += " [" + fallback + "]"
		}
		if err := console.Write(ctx, prompt+": "); err != nil {
			return "", err
		}
		var data []byte
		for {
			key, err := console.ReadKey(ctx)
			if err != nil {
				return "", err
			}
			switch key {
			case 3, 4:
				return "", io.EOF
			case '\r', '\n':
				if err := console.Write(ctx, "\r\n"); err != nil {
					return "", err
				}
				value := strings.TrimSpace(string(data))
				if !utf8.ValidString(value) {
					return "", errors.New("invalid text")
				}
				if value == "" {
					value = fallback
				}
				return value, nil
			case 8, 127:
				if len(data) > 0 {
					_, size := utf8.DecodeLastRune(data)
					data = data[:len(data)-size]
					if err := console.Write(ctx, "\b \b"); err != nil {
						return "", err
					}
				}
			default:
				if key < 32 || len(data) >= 4096 {
					return "", errors.New("input too long or invalid")
				}
				data = append(data, key)
				if err := console.Write(ctx, string([]byte{key})); err != nil {
					return "", err
				}
			}
		}
	}
	for {
		menu := "TailMouse — what would you like to share?\r\n1 Web app  2 Terminal  3 Send file  4 Read-only folder\r\n5 Temporary text  7 Terminal + web  q Quit\r\n"
		if platform != "windows" {
			menu += "6 Receive files\r\n"
		}
		if err := console.Write(ctx, menu); err != nil {
			return nil, err
		}
		choice, err := ask("Choose", "1")
		if err != nil {
			return nil, err
		}
		if choice == "q" {
			return nil, io.EOF
		}
		command, prompt, fallback := "", "", ""
		switch choice {
		case "1":
			command, prompt, fallback = "web", "Local port or URL", "8080"
		case "3":
			command, prompt = "send", "File to send"
		case "4":
			command, prompt, fallback = "files", "Read-only directory", "."
		case "5":
			command, prompt = "text", "Text to share (empty starts an empty text session)"
		case "6":
			if platform == "windows" {
				if err := console.Write(ctx, "Receive is unavailable on Windows. Choose Send file, folder, text, web or terminal.\r\n"); err != nil {
					return nil, err
				}
				continue
			}
			command, prompt, fallback = "receive", "Dedicated upload directory", "./tailmouse-uploads"
		case "2", "7":
			var target string
			if choice == "7" {
				target, err = ask("Local web port or URL", "8080")
				if err != nil {
					return nil, err
				}
			}
			program := "sh"
			if platform == "windows" {
				program = "powershell.exe"
			}
			program, err = ask("Executable (one program path, no shell arguments)", program)
			if err != nil {
				return nil, err
			}
			access := ""
			for access != "1" && access != "2" {
				access, err = ask("Terminal access: 1 view-only, 2 allow input", "1")
				if err != nil {
					return nil, err
				}
			}
			permission := "view only"
			if access == "2" {
				permission = "control input"
			}
			confirm, err := ask(fmt.Sprintf("Start %s and let the visitor %s? y/N", program, permission), "n")
			if err != nil {
				return nil, err
			}
			if !strings.EqualFold(confirm, "y") {
				return nil, io.EOF
			}
			args := []string{"cli"}
			if choice == "7" {
				args = []string{"dev", "--web", target}
			}
			if access == "1" {
				args = append(args, "--read-only")
			}
			return append(args, "--", program), nil
		default:
			if err := console.Write(ctx, "Choose one of the listed resources, or q to quit.\r\n"); err != nil {
				return nil, err
			}
			continue
		}
		var value string
		for {
			value, err = ask(prompt, fallback)
			if err != nil {
				return nil, err
			}
			if command == "send" || command == "files" {
				info, problem := os.Lstat(value)
				if problem != nil || (command == "send" && !info.Mode().IsRegular()) || (command == "files" && !info.IsDir()) {
					if err := console.Write(ctx, "Choose an existing regular file or directory for this resource. Try again, or Ctrl+C to quit.\r\n"); err != nil {
						return nil, err
					}
					continue
				}
			}
			break
		}
		if command == "receive" {
			if _, err := os.Stat(value); errors.Is(err, os.ErrNotExist) {
				confirm, err := ask("Create this dedicated upload directory? y/N", "n")
				if err != nil {
					return nil, err
				}
				if !strings.EqualFold(confirm, "y") {
					return nil, io.EOF
				}
				if err := os.Mkdir(value, 0700); err != nil {
					return nil, errors.New("could not create upload directory")
				}
			}
		}
		return []string{command, value}, nil
	}
}
