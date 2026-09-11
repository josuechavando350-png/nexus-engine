package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

var ErrHashMismatch = errors.New("deterministic input hash mismatch")

func CanonicalDigest(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func VerifyDigest(v any, expected string) error {
	got, err := CanonicalDigest(v)
	if err != nil {
		return err
	}
	if got != expected {
		return ErrHashMismatch
	}
	return nil
}
