package session

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"io"
	"time"

	"tailmouse/apps/cli/internal/protocol"
)

const accessAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

const (
	accessCodeLength = 16
	challengeLength  = 32
)

var ErrInvalidAccessCode = errors.New("invalid access code")
var errAuthenticationBudget = errors.New("authentication byte budget exceeded")

type AccessCode [accessCodeLength]byte

func GenerateAccessCode() (AccessCode, error) {
	return newAccessCode(rand.Reader)
}

func newAccessCode(random io.Reader) (AccessCode, error) {
	var entropy [accessCodeLength]byte
	if random == nil {
		return AccessCode{}, ErrInvalidAccessCode
	}
	if _, err := io.ReadFull(random, entropy[:]); err != nil {
		clear(entropy[:])
		return AccessCode{}, ErrInvalidAccessCode
	}
	var code AccessCode
	for index, value := range entropy {
		code[index] = accessAlphabet[value&31]
	}
	clear(entropy[:])
	return code, nil
}

func newAccessChallenge(random io.Reader) ([challengeLength]byte, error) {
	var challenge [challengeLength]byte
	if random == nil {
		return challenge, ErrInvalidAccessCode
	}
	if _, err := io.ReadFull(random, challenge[:]); err != nil {
		clear(challenge[:])
		return challenge, ErrInvalidAccessCode
	}
	return challenge, nil
}

func CanonicalAccessCode(input string) (AccessCode, error) {
	var code AccessCode
	length := 0
	for index := 0; index < len(input); index++ {
		value := input[index]
		if value == ' ' || value == '-' {
			continue
		}
		if value >= 'a' && value <= 'z' {
			value -= 'a' - 'A'
		}
		if length == len(code) || !validAccessSymbol(value) {
			clear(code[:])
			return AccessCode{}, ErrInvalidAccessCode
		}
		code[length] = value
		length++
	}
	if length != len(code) {
		clear(code[:])
		return AccessCode{}, ErrInvalidAccessCode
	}
	return code, nil
}

func (code AccessCode) Grouped() string {
	var grouped [accessCodeLength + 3]byte
	output := 0
	for index, symbol := range code {
		if index != 0 && index%4 == 0 {
			grouped[output] = '-'
			output++
		}
		grouped[output] = symbol
		output++
	}
	return string(grouped[:])
}

func DeriveAccessKey(code AccessCode) [32]byte {
	digest := sha256.New()
	_, _ = digest.Write([]byte("tailmouse-access-key-v1\x00"))
	_, _ = digest.Write(code[:])
	var key [32]byte
	digest.Sum(key[:0])
	return key
}

func AccessProof(code AccessCode, sessionID [16]byte, challenge [challengeLength]byte) [32]byte {
	key := DeriveAccessKey(code)
	proof := hmac.New(sha256.New, key[:])
	_, _ = proof.Write([]byte("tailmouse-access-proof-v1\x00"))
	_, _ = proof.Write(sessionID[:])
	_, _ = proof.Write(challenge[:])
	clear(key[:])
	var result [32]byte
	proof.Sum(result[:0])
	return result
}

func VerifyAccessProof(code AccessCode, sessionID [16]byte, challenge [challengeLength]byte, proof [32]byte) bool {
	expected := AccessProof(code, sessionID, challenge)
	valid := subtle.ConstantTimeCompare(expected[:], proof[:]) == 1
	clear(expected[:])
	return valid
}

func validAccessSymbol(value byte) bool {
	for index := 0; index < len(accessAlphabet); index++ {
		if accessAlphabet[index] == value {
			return true
		}
	}
	return false
}

func (host *Host) pendingAuthenticationLocked() int {
	pending := 0
	for connection := range host.connections {
		if connection.lease == 0 {
			pending++
		}
	}
	return pending
}

func (host *Host) issueChallenge(connection *hostConnection) ([challengeLength]byte, error) {
	host.mu.Lock()
	defer host.mu.Unlock()
	challenge, err := newAccessChallenge(host.entropy)
	if err != nil {
		return challenge, err
	}
	connection.challenge = challenge
	connection.challengeIssued = true
	return challenge, nil
}

func (host *Host) consumeChallenge(connection *hostConnection) ([challengeLength]byte, bool) {
	host.mu.Lock()
	defer host.mu.Unlock()
	challenge, issued := connection.challenge, connection.challengeIssued
	clear(connection.challenge[:])
	connection.challengeIssued = false
	return challenge, issued
}

func (host *Host) authenticationThrottle(now time.Time) error {
	host.mu.Lock()
	defer host.mu.Unlock()
	return host.authenticationThrottleLocked(now)
}

func (host *Host) authenticationThrottleLocked(now time.Time) error {
	if host.authCooldownUntil.IsZero() {
		return nil
	}
	if !now.Before(host.authCooldownUntil) {
		host.authFailures = 0
		host.authCooldownUntil = time.Time{}
		return nil
	}
	remaining := host.authCooldownUntil.Sub(now)
	retryAfter := (remaining + time.Millisecond - 1) / time.Millisecond
	if retryAfter > 30_000 {
		retryAfter = 30_000
	}
	return &protocol.ProtocolError{Code: protocol.CodeAuthThrottled, RetryAfterMS: uint32(retryAfter)}
}

func (host *Host) authenticationFailure(now time.Time) error {
	host.mu.Lock()
	defer host.mu.Unlock()
	if err := host.authenticationThrottleLocked(now); err != nil {
		return err
	}
	host.authFailures++
	if host.authFailures == authenticationFailures {
		host.authCooldownUntil = now.Add(authenticationCooldown)
	}
	return &protocol.ProtocolError{Code: protocol.CodeAuthFailed}
}

func (host *Host) authenticationSucceeded(connection *hostConnection) {
	host.mu.Lock()
	defer host.mu.Unlock()
	host.authFailures = 0
	host.authCooldownUntil = time.Time{}
	connection.authenticated = true
}

func (host *Host) clearAuthenticationLocked() {
	clear(host.accessCode[:])
	host.authFailures = 0
	host.authCooldownUntil = time.Time{}
	for connection := range host.connections {
		clear(connection.challenge[:])
		connection.challengeIssued = false
		connection.authenticated = false
	}
}
