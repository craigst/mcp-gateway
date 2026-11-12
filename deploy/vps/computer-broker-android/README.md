# Razer Phone (android) connector — pi5-doc Docker

Moved off **gpc** and then **cleo** on 2026-11-06: both are machines that get
switched off, and the phone's computer-use died with them for days. It now runs
as a small Docker container on **pi5-doc** (`10.10.254.85`), the always-on
DNS/ingress host. The broker and gateway stay on the USA VPS.

Live layout on the pi5: `/opt/computer-broker-android/`

```
docker-compose.yml
connector-android.env        # from .example, mode 0600
build/Dockerfile             # this directory
build/connector/             # the broker connector package (v1.1.1)
state/                       # identity.json, private_key.pem, policy.json, broker-ca.pem
adb-keys/adbkey,adbkey.pub   # an ADB key the phone already trusts
```

## Deploy

1. `build/connector/` = the `connector/` package from the "computer broker"
   checkout (same version as the other hosts).
2. `state/` = the connector identity/policy/CA. `state/policy.json` must set
   `android.adb_serial` to the phone's Wi-Fi ADB endpoint
   (`10.10.254.80:5555` today).
3. `adb-keys/` = a private key the phone has already authorised (the phone
   shows an "Allow USB debugging" prompt for an unknown key, and that needs the
   screen).
4. `cp connector-android.env.example connector-android.env && chmod 600 connector-android.env`
5. `docker compose up -d --build`
6. `docker logs -f computer-broker-connector-android` → `ready as cnr_…`

## Why the healthcheck

The connector's background frame pump swallows ADB errors and never calls
`adb connect` again. Without the 30 s healthcheck a dropped Wi-Fi transport
freezes the viewer while the connector still looks healthy.
