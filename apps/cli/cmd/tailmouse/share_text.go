package main

import (
	"io"
	"tailmouse/apps/cli/internal/share"
	"unicode/utf8"
)

// This is the command's deliberate text-sharing surface, never diagnostics.
type shareTextInput struct {
	data   []byte
	skipLF bool
	escape int
}

func (input *shareTextInput) Feed(host *share.Host, data []byte, output io.Writer) error {
	for _, key := range data {
		if input.escape > 0 {
			if input.escape == 1 && (key == '[' || key == 'O') {
				input.escape = 2
				continue
			}
			if input.escape == 1 || key >= 0x40 && key <= 0x7e {
				input.escape = 0
			}
			continue
		}
		if key == 27 {
			input.escape = 1
			continue
		}
		if key == '\n' && input.skipLF {
			input.skipLF = false
			continue
		}
		input.skipLF = false
		switch key {
		case '\r', '\n':
			if err := host.ReplaceText(string(input.data)); err != nil {
				return err
			}
			clear(input.data)
			input.data = input.data[:0]
			input.skipLF = key == '\r'
			if _, err := io.WriteString(output, "\r\nShared text updated.\r\n"); err != nil {
				return err
			}
		case 8, 127:
			if len(input.data) > 0 {
				_, size := utf8.DecodeLastRune(input.data)
				clear(input.data[len(input.data)-size:])
				input.data = input.data[:len(input.data)-size]
				if _, err := io.WriteString(output, "\b \b"); err != nil {
					return err
				}
			}
		default:
			if key < 32 && key != '\t' || len(input.data) >= share.MaxText {
				continue
			}
			input.data = append(input.data, key)
			if _, err := output.Write([]byte{key}); err != nil {
				return err
			}
		}
	}
	return nil
}
