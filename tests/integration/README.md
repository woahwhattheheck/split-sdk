# Stellar testnet integration tests

These tests run against the real Stellar Soroban **testnet**.

The integration suite requires a deployed testnet contract id and refuses to run without `STELLAR_NETWORK=testnet`.

Run locally from the repository root:

```bash
STELLAR_NETWORK=testnet \
STELLAR_SPLIT_CONTRACT_ID=... \
npm run test:integration
```

`STELLAR_SPLIT_TOKEN_CONTRACT_ID` is optional. When omitted, the current integration suite falls back to the split contract id to match its existing test behavior.

The GitHub Actions integration workflow is label-gated (`integration`) and reads `STELLAR_SPLIT_CONTRACT_ID` and, optionally, `STELLAR_SPLIT_TOKEN_CONTRACT_ID` from repository secrets. It type-checks before contacting testnet and fails early with a clear configuration error when the required contract id secret is missing.
