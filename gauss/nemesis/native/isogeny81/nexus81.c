/* Némesis #81 native transport: REAL SQIsign NIST API, not the small-field Vélu demo.
 * SPDX-License-Identifier: Apache-2.0 (integration code); SQIsign is separately licensed.
 * Protocol: --keygen -> stdout pk||sk; --sign stdin sk||message -> stdout signature;
 * --verify stdin pk||signature||message -> stdout one byte 0 or 1.
 * No secrets in argv or diagnostic output. The JS boundary pins the executable.
 */
#include <api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_MESSAGE 65536u

static void wipe(void *ptr, size_t size) {
    volatile unsigned char *p = (volatile unsigned char *)ptr;
    while (size--) *p++ = 0;
}

static int failure(void) {
    fputs("NEMESIS_81_NATIVE_FAILED\n", stderr);
    return 2;
}

static int write_exact(const void *data, size_t size) {
    return fwrite(data, 1, size, stdout) == size && fflush(stdout) == 0;
}

static int read_bounded(unsigned char *bytes, size_t capacity, size_t *length) {
    size_t read_count = 0;
    while (read_count < capacity) {
        size_t n = fread(bytes + read_count, 1, capacity - read_count, stdin);
        read_count += n;
        if (n == 0) {
            if (ferror(stdin)) return 0;
            break;
        }
    }
    if (read_count == capacity && fgetc(stdin) != EOF) return 0;
    if (ferror(stdin)) return 0;
    *length = read_count;
    return 1;
}

static int keygen(void) {
    unsigned char pk[CRYPTO_PUBLICKEYBYTES], sk[CRYPTO_SECRETKEYBYTES];
    int result = crypto_sign_keypair(pk, sk);
    int ok = result == 0 && write_exact(pk, sizeof(pk)) && write_exact(sk, sizeof(sk));
    wipe(sk, sizeof(sk));
    return ok ? 0 : failure();
}

static int signing(void) {
    unsigned char *bytes = malloc(CRYPTO_SECRETKEYBYTES + MAX_MESSAGE);
    if (!bytes) return failure();
    size_t len = 0;
    unsigned char signature[CRYPTO_BYTES];
    unsigned long long siglen = 0;
    int ok = read_bounded(bytes, CRYPTO_SECRETKEYBYTES + MAX_MESSAGE, &len)
        && len >= CRYPTO_SECRETKEYBYTES
        && crypto_sign_signature(signature, &siglen,
            bytes + CRYPTO_SECRETKEYBYTES,
            (unsigned long long)(len - CRYPTO_SECRETKEYBYTES), bytes) == 0
        && siglen == CRYPTO_BYTES && write_exact(signature, CRYPTO_BYTES);
    wipe(signature, sizeof(signature));
    wipe(bytes, CRYPTO_SECRETKEYBYTES + MAX_MESSAGE);
    free(bytes);
    return ok ? 0 : failure();
}

static int verification(void) {
    const size_t prefix = CRYPTO_PUBLICKEYBYTES + CRYPTO_BYTES;
    unsigned char *bytes = malloc(prefix + MAX_MESSAGE);
    if (!bytes) return failure();
    size_t len = 0;
    int ok = read_bounded(bytes, prefix + MAX_MESSAGE, &len) && len >= prefix;
    if (!ok) { free(bytes); return failure(); }
    unsigned char accepted = crypto_sign_verify(bytes + CRYPTO_PUBLICKEYBYTES,
        CRYPTO_BYTES, bytes + prefix, (unsigned long long)(len - prefix), bytes) == 0;
    free(bytes);
    return write_exact(&accepted, 1) ? 0 : failure();
}

int main(int argc, char **argv) {
    if (argc != 2) return failure();
    if (strcmp(argv[1], "--keygen") == 0) return keygen();
    if (strcmp(argv[1], "--sign") == 0) return signing();
    if (strcmp(argv[1], "--verify") == 0) return verification();
    return failure();
}
