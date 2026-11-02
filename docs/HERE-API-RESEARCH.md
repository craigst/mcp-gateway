# HERE Platform API Research — HGV Navigation MCP Server

**Status:** research complete and live-validated. The endpoint reference, auth model, UK/HGV semantics, AI/MCP landscape and recommended tool surface are all settled.
**Credential situation (short version):** the value the operator supplied is **not** a Location Services API key (§1). A **working** LSS key was separately located in the operator's vault (`bca-btt-here-api-key`, 43 chars) and validated live by the Lead — geocode, revgeocode, discover, autosuggest, Routing v8 truck, Isoline v8 truck, Traffic incidents, Waypoint Sequence and Map Image all returned **200** (§6). The MCP server must therefore take **`HERE_API_KEY`** and pass it as **`?apiKey=`**.
**Research date:** 2026-11-02. **Method:** live `curl` against `*.hereapi.com` + HERE's own machine-readable docs (`https://docs.here.com/llms.txt`; append `.md` to any doc page for clean markdown; each OpenAPI reference page embeds its full spec, which was parsed for exact parameter names, units, ranges and enums).

**Provenance tags used below**
- `[LIVE]` — verified by an actual HTTP call made during this research.
- `[DOCS]` — quoted/derived from HERE's current documentation (OpenAPI spec or guide page), source URL given.
- `[UNVERIFIED]` — could not confirm; do not rely on it.

---

## 1. Credential findings — read this first

### 1.1 What the supplied value actually is

The value supplied as "a HERE REST app API key" is **not** a Location Services API key. Base64-decoded it is:

```
reftkn:01:<redacted-project-id>:<redacted-secret>
```

That is a HERE **platform Maven Repository access token** (the `reftkn:` reference-token shape used as a bearer credential for HERE's artifact repo), *not* an `apiKey`.

**Evidence — live:**

| Probe | Result |
|---|---|
| `?apiKey=<value>` on `geocode.search.hereapi.com` | `401` `{"error":"Unauthorized","error_description":"apiKey invalid. apiKey not found."}` |
| Same, with a deliberately random 64-char key (control) | `401`, **byte-identical** error |
| Same, with **no** key at all | `401` `{"error":"Unauthorized","error_description":"No credentials found"}` |
| `Authorization: Bearer <value>` on Location Services | `401` `{"error":"Unauthorized","error_description":"Token Validation Failure - unrecognized kid null"}` (it is parsed as a JWT and rejected) |
| `Authorization: Bearer <value>` → `https://repo.platform.here.com/artifactory/open-location-platform/` | **`200`** |
| Same URL anonymous / with a bogus bearer | `401 "Browse request for repo..."` / `401 "Props Authentication Token not found"` |

The identical error to a random key proves this is **"key not found"**, not a 403-style entitlement/quota problem. The Artifactory result (200 for ours, 401 for anonymous and for a bogus bearer) proves the token is a *live, valid* credential — for the **artifact repo**, a different control plane from Location Services.

HERE documents exactly this credential type: *"To create credentials for accessing the HERE platform Maven Repository … Sign in to the HERE platform → **Launcher > Access manager > Access tokens** → **Create token** → Download the `settings.xml`"* — which is the file this token came from. [DOCS: https://docs.here.com/identity-and-access-management/docs/get-platform-repository-credentials.md]

### 1.2 Can it be exchanged for a usable Location Services token? **No.**

Tested live against HERE's OAuth token endpoint (`https://account.api.here.com/oauth2/token`, the endpoint the docs name as the token endpoint):

| Attempt | Result |
|---|---|
| `client_credentials`, body `client_id=<project-id>&client_secret=<secret>` | `401` `{"errorCode":401300,"message":"Invalid client credentials.",...}` |
| Control: `client_credentials` with random `client_id`/`client_secret` | `401`, **same** `401300` error |
| `client_credentials` via `Basic` auth | `400` `400200` `errorFields:[{name:"client_id"}]` |
| `refresh_token` grant (`raw` value, decoded value, with/without client creds) | `400` `client_id` missing, or `401` `invalid_client` |

And the server's own metadata is decisive [LIVE: `https://account.api.here.com/.well-known/oauth-authorization-server`]:

```json
{"issuer":"https://account.api.here.com",
 "token_endpoint":"https://account.api.here.com/oauth2/token",
 "token_endpoint_auth_methods_supported":["private_key_jwt"],
 "response_types_supported":["token"],
 "grant_types_supported":["client_credentials"]}
```

**Conclusion:** the token endpoint advertises only `client_credentials` with `private_key_jwt` client authentication (the docs additionally allow OAuth 1.0 HMAC-SHA256 signed requests, using an **Access Key ID + Access Key Secret**). There is no `refresh_token` grant and no `client_secret_basic`, so a Maven-repo token cannot be turned into an access token. A usable credential must be **created**, not derived.

### 1.3 How to get a working API key (operator steps)

1. Sign in to **https://platform.here.com** with a HERE account (create one if needed).
2. Open **Access Manager** from the launcher.
3. **Apps** tab → **Register new app** → fill in → **Register**. (New apps get the *Restricted IAM Access* filter applied automatically — that does **not** affect access to subscribed location services, so it is fine here.)
4. Open the app → **Credentials** tab → **API Keys** → **Create API key**. **Maximum two API keys per app** (the second is also the rotation story: create the new one, retire the old).
5. Use it as `?apiKey=<key>`.

Notes [DOCS: https://docs.here.com/identity-and-access-management/docs/plat-using-apikeys.md, …/manage-apps.md]:
- If the **Credentials** tab is missing/greyed out you lack manager permission on that app.
- App credentials **do not inherit** your user permissions or group memberships.
- Optional hardening: **Trusted domains** tab (up to 20 domains) to bind the key to specific origins; changes can take **up to 30 minutes** to apply.
- The *Access tokens* page used to produce the token you have is a **different** feature (artifact repo) — do not confuse the two: **Access Manager → Access tokens** (Maven repo) vs **Access Manager → Apps → Credentials → API Keys** (Location Services).

**OAuth alternative** (if you prefer bearer tokens): app → **Credentials → OAuth 2.0 → Create credentials → Download `credentials.properties`**. That file contains `here.client.id` (the app id), the token endpoint URL, **Access Key ID** and **Access Key Secret** — note *"once you click Close, you can no longer access your access key ID and access key secret."* Access tokens last **up to 24 hours**; an expired token yields `401`. Token-request rate limit: **25,000 requests / 15 min per appId** (enforced at 1,666/min). [DOCS: https://docs.here.com/identity-and-access-management/docs/how-to-authorize-with-oauth-20.md]

### 1.4 The working credential, and how the MCP server should use it

A working Location Services key was found in the operator's vault: **alias `bca-btt-here-api-key`, 43 characters, provider `here`**. The Lead validated it live — all Location Services families returned **200** (§6.2). Use that key, not the value in the original request.

**Wiring rules for the builder:**
- Env var **`HERE_API_KEY`**; pass as **`?apiKey=<key>`** on the query string. That is the only documented API-key mechanism (§2).
- **Never** accept a key from the model or from tool arguments, and never echo it in errors or logs.
- On `401` (`apiKey invalid` / `Token or apiKey is missing.`) return: *"HERE API key missing or invalid — set HERE_API_KEY (create one at platform.here.com → Access Manager → Apps → Credentials → API Keys)."* On `403` (`These credentials do not authorize access…`) the key is valid but **not entitled** to that service/plan — a different fix, so do not conflate the two.
- `.gitignore` already excludes `.env` / `.env.*`; keep the key out of the repo and out of docs.

> ⚠️ **Do not paste HERE platform Maven-repo tokens (`reftkn:…`) into `HERE_API_KEY`.** They authenticate to `repo.platform.here.com` (artifact downloads) and are rejected by every Location Services host — that is precisely the failure in §1.1–§1.2. Only an **Access Manager → Apps → Credentials → API Keys** value works.

---

## 2. Authentication model

| Aspect | Detail |
|---|---|
| Scheme A — **API key** | `?apiKey=<API_KEY>` **query parameter only.** Every OpenAPI spec declares `"ApiKey": {"type":"apiKey","name":"apiKey","in":"query"}` — there is no API-key *header* scheme. [DOCS: GSearch `get_geocode.md`, Routing `routing-api-v8-calculateroutes.md`, Traffic `traffic-api-v7-getflow.md`, Map Image `getimage.md`] |
| Scheme B — **OAuth** | `Authorization: Bearer <ACCESS_TOKEN>`, where the token is an **OAuth 2.0/2.1 JWT** (`"Bearer": {"type":"http","scheme":"bearer","bearerFormat":"JWT"}`). An API key sent as Bearer fails: `Token Validation Failure - unrecognized kid null` [LIVE] |
| Per-API declaration | All location APIs: `security: [{"Bearer":[]},{"ApiKey":[]}]` — both accepted |
| Token endpoint | `https://account.api.here.com/oauth2/token`; client auth = `private_key_jwt` (**recommended**) or OAuth 1.0 HMAC-SHA256 signed request with Access Key ID/Secret. Grants: `client_credentials`, token-exchange, `jwtIssNotHERE`. No `client_secret_basic`. |
| Token lifetime | `expiresIn` default 3600 s, **max 86400** (~24 h); `401` when expired |
| Which to use | Docs: *"Oauth tokens are recommended for production. This example uses an `apiKey` to allow you to quickly try the API."* → **the MCP server should use the API key** (one env var, no refresh loop); OAuth only if an org mandates it or for platform APIs (Usage/IAM), which reject API keys. |
| Request tracing | Send **`X-Request-ID`** (or `X-Request-ID`/`X-Request-Id` — casing is inconsistent across services); read back the server's **`X-Correlation-ID`** and log it. `HERE-Request-Id` is **not** documented [UNVERIFIED]. |
| Transport / CORS | HTTPS only, `*.hereapi.com`. **CORS is not documented anywhere** in GSearch/Routing/Traffic/Map Image docs — assume a browser client will be blocked; use a server-side proxy. |
| Do not send | `Authorization: Bearer <apiKey>` (fails), `Authorization: apiKey …` (fails), or a Maven-repo `reftkn:` token as `apiKey` (§1). |
| Key format | Opaque; HERE does **not** document an internal format. (Observation only: the bad credential decoded to a `reftkn:` reference-token payload — that is an artifact-repo token, §1.1.) |

### 2.1 Base hosts

| Service | Host |
|---|---|
| Geocode / Reverse geocode / Discover / Autosuggest / Lookup | `geocode.search.hereapi.com`, `revgeocode.search.hereapi.com`, `discover.search.hereapi.com`, `autosuggest.search.hereapi.com`, `lookup.search.hereapi.com` |
| Routing v8 | `router.hereapi.com` |
| Matrix Routing v8 | `matrix.router.hereapi.com` (poll URLs may be region hosts, e.g. `routing-matrix-region-1.router.hereapi.com`) |
| Isoline Routing v8 | `isoline.router.hereapi.com` |
| Waypoint Sequence v8 | `wps.hereapi.com` |
| Traffic v7 | `data.traffic.hereapi.com` |
| Map Image v3 | `image.maps.hereapi.com` |
| OAuth / IAM | `account.api.here.com` |
| Location Reasoning MCP (AI) | `hlr.here.ai` (§6) |

### 2.2 Error shapes (they are **not** uniform — normalise per family)

**Location Services "simple" shape** (geocode, routing auth failures, map image) [LIVE]:
```json
{"error":"Unauthorized","error_description":"apiKey invalid. apiKey not found."}
```

**Geocoding & Search v7 `ErrorResponse`** [DOCS]: `{status, title, code, cause, action, correlationId, requestId}` (required: `status`, `title`, `correlationId`, `requestId`); returned on 400/405/429/503.

**Routing v8** [DOCS: routing-api-v8-calculateroutes.md]: `{title, status, code, cause, action, correlationId}` with `E605xxx` codes — `E60500X` malformed query, `E605010` bad vehicle/transportMode combination, `E605011` bad avoid combination, `E605012` bad transportMode/routingMode, `E605013` invalid `return` option, `E605015` too many alternatives, `E605016` invalid country code, `E605017` spans/return dependency, `E605018` departure+arrival together. HTTP 200/400/401/403/500; a 403 may instead use the simple `{error, error_description}` shape. **Non-fatal problems are not errors** — they appear in top-level `notices[]` (`noRouteFound`, `couldNotMatchOrigin`, `routeLengthLimitExceeded`, `violatedTruckRoadType`, …). The MCP server must surface notices, not just HTTP status.

**IAM/token endpoint** [LIVE]: `{"errorId":"ERROR-<uuid>","httpStatus":400,"errorCode":400200,"message":"Received invalid data. See json element 'errorFields'…","errorFields":[…]}`; `401` → `errorCode 401300`, `error: "invalid_client"`.

**MCP (Location Reasoning)** [LIVE]: JSON-RPC error envelope, e.g. `{"error":{"message":"Missing or invalid Authorization header","code":-32001,"data":{"error":"Unauthorized","status":401}},"jsonrpc":"2.0"}`.

**Rule of thumb: parse by *shape*, not just status.** Auth faults (401/403) → `{error, error_description}`; validation/server faults → `{title, status, code, cause, action, correlationId}`. Per-service code prefixes [DOCS]:

| Family | Code prefix | Notable codes |
|---|---|---|
| Routing v8 / Isoline v8 | **E605** | `E605001` missing field, `E605010` bad vehicle/mode combo, `E605013` bad `return`, `E605017` spans dependency, `E605018` departure+arrival together, `E605019` `weightPerAxle`+`weightPerAxleGroup` conflict, `E605024` weight exceeds limit for mode, `E605054` too many avoid areas, `E605501` "Too many requests" |
| Matrix v8 | **E601** | `E601111` "Rate limit exceeded", `E601215` "Size of matrix exceeds limit", `E601104` invalid request size |
| Traffic v7 | **E608** | `E608045` request URI too long (HTTP **414**) |
| Map Image v3 | **E622** | `E622002–E622010` (400) |
| Usage API v2 | **E706** | — |
| IAM | — | `401200` header missing, `401202` malformed OAuth header, `401204` timestamp outside window, `401207` nonce reused, **`401310` "client ID used instead of access key id"**, `403403` not authorized, **`429002` "too many requests"** |

**401 vs 403 — do not conflate (this is the #1 integration trap):**
- **401** = credential not recognised. Documented verbatim example: `{"error":"Unauthorized","error_description":"ApiKey invalid. ApiKey not found."}` (casing of `apiKey`/`ApiKey` is *unstable* — match case-insensitively). Also seen: `Token or apiKey is missing.`, `No credentials found`.
- **403** = credential fine, **entitlement** missing. Verbatim: `{"error":"Forbidden","error_description":"These credentials do not authorize access. Please contact your customer representative or submit a request here https://developer.here.com/contact-us to upgrade your account…"}`; the IAM-native variant is structured: `{"title":"Forbidden","status":403,"code":"403403","cause":"…do not authorize access to perform invoke action on hrn:here::…:routing…","action":"Add/Share the necessary permissions to the identity."}`

**Status meanings** [DOCS: `geocoding-and-search/docs/http-status-codes`]: 400 invalid parameter value · 401 invalid authentication · 403 invalid credentials/prohibited · 404 not found · **414 URI too long** · 429 too many requests · 500 server config · 503 temporarily unavailable · 504 temporarily offline.

### 2.3 Quotas and rate limits

- Exceeding a quota → **HTTP 429 or 503** *"and a message that the account has exceeded the quota."* Additionally HERE may return **429/503 during demand surges, for up to ~10 minutes, *even if the user's quotas were not reached*** [DOCS: https://docs.here.com/policies/docs/limits-and-quotas.md]. ⇒ 429/503 must trigger **backoff + retry**, never a hard failure.
- **Numeric rate limits and monthly transaction volumes are not published** in any API reference. Pricing/plan volumes live at `https://www.here.com/get-started/pricing` (JS-rendered → figures **UNVERIFIED** here; read them in the portal for the account that owns the key).
- **Reading enforced limits (the correct programmatic approach):** IAM **Rate Limit Rules API v1** — `GET /identities/me/rules`, `/identities/default/rules`, `/identities/{identityHrn}/rules`, plus `/endpoints`; accepts `endpointId`, `url`, `projectHrn`. Rule shape: `RateLimitValue {period: seconds|minutes|hours|days, periodValue, value}`; `metric: apiCalls | bytesIn | bytesInPerRequest` — note **`bytesIn` breaches return 413 and `bytesInPerRequest` returns 402**, not 429. `groupingMask` includes `realmHrn`, `appHrn`, `projectHrn`, `endpointId`, `path`, `identityHrn`, `tokenHrn`. [DOCS: https://docs.here.com/identity-and-access-management/docs/how-to-find-rate-limit-rules.md; reference: `rate-limit-rules-api-v1-getratelimitrulesme.md`]
- **There is no "remaining quota" endpoint.** The Usage / Cost Management API reports *consumed* billable usage only:
  `GET https://usage.bam.api.here.com/v2/usage/realms/{realmId}?startDate=…&endDate=…` → `{total, limit, items[], nextOffset}`, each item carrying `usageValue` (raw units, e.g. API calls) and `billableValue` (transactions), plus `appHrn`, `projectHrn`, `featureId`, `valueDriver` ("Transactions"/"GB"). Optional `featureId` (e.g. `hrn:here:service::olp-here:search-geocoding-1`), `appId`, `projectHrn`, `groupBy`, `detailLevel`, `limit`≤100. **Auth is bearer-JWT only — `security: [{"token": []}]`, no API-key scheme** — so a plain REST app key **cannot** read it; you need platform OAuth credentials (app Access Key ID/Secret) and realm access. Data is also split hot/cold (`channelId`), so it lags → **not a real-time gauge**. [DOCS: https://docs.here.com/usage/reference/getusagebyrealm.md, …/usage/docs/get-started.md]
- **Per-response quota headers: none documented** [UNVERIFIED] — do not parse headers for quota. If the operator needs budget control, do client-side accounting or call the Rate Limit Rules API.
- **Practical guidance for the MCP server:** retry 429/503 with exponential backoff and jitter (cap ~3 attempts, ~10 min horizon), surface `Retry-After` if present, and never silently return partial data as success.

---

## 3. Endpoint reference

> **Sample responses:** most endpoints below now carry a **real captured payload** (`[LIVE]`, §6.2) in addition to the field-complete `[DOCS-SHAPE]` skeleton transcribed from HERE's OpenAPI definitions. Where only `[DOCS-SHAPE]` appears, the shape is still exact but was not exercised live — snapshot one real payload into the MCP server's fixtures when convenient.

---

### 3.1 Geocoding & Search v7

**Auth:** `?apiKey=` or Bearer. **Errors:** `ErrorResponse`. All four endpoints cap `limit` at **100**. `politicalView` is supported on all four (single uppercase ISO-3). `lang` is a BCP-47 array; **use `lang=en-GB` for the UK**.

#### 3.1.1 Geocode — `GET https://geocode.search.hereapi.com/v1/geocode`
**Required:** `q` **or** `qq` (either; both may be sent).

| Param | Notes |
|---|---|
| `q` | free-text query, e.g. `EC2M 7EB` or `Prospect Place, Blackburn BB1 4DB` |
| `qq` | structured query: `country=GBR;city=Manchester;street=Deansgate;houseNumber=1;postalCode=M3 2AA` (sub-keys `country,state,county,city,district,street,houseNumber,postalCode`) |
| `at` | `lat,lng` — "centre of the search context"; drives `distance` ranking |
| `in` | **`countryCode:` only** (e.g. `in=countryCode:GBR`, or comma list `countryCode:CAN,MEX,USA`). ⚠️ **No `circle:`/`bbox:` on this endpoint** (they exist on `/discover` and `/autosuggest`). |
| `limit` | 1–100, default 20 |
| `lang` | BCP-47, e.g. `en-GB` |
| `types` | `address, area, city, houseNumber, place, postalCode, street` |
| `showNavAttributes` | `access, functionalClass, physical, speedLimits` — **the HGV-relevant one**: returns per-result `navigationAttributes.access` booleans incl. **`trucks`**, plus `deliveries`, `throughTraffic` |
| `show` | `countryInfo, parsing, postalCodeDetails, secondaryUnitInfo, streetInfo, tz, addressUsage` |
| `showMapReferences` | `adminIds, cmVersion, links, pointAddress, segments` (`microPointAddress` restricted) |
| `showRelated` | `intersections, nearbyAddress, parentPA` |
| other | `politicalView`, `showTranslations`, `addressNamesMode` (`matched`/`normalized`), `postalCodeMode` (`cityLookup`/`districtLookup`), `X-Request-ID` |

**Response** `[DOCS-SHAPE]` — single top-level `items[]` (required), ranked most→least likely:
```json
{
  "items": [
    {
      "title": "EC2M 7EB",
      "id": "here:cm:namedplace:...",
      "resultType": "postalCodePoint",      // address|area|city|houseNumber|place|postalCode|street|addressBlock|intersection|locality|administrativeArea
      "houseNumberType": "interpolated",     // MPA|PA|interpolated
      "address": {
        "label": "EC2M 7EB, United Kingdom",
        "countryCode": "GBR", "countryName": "United Kingdom",
        "city": "London", "postalCode": "EC2M 7EB",
        "street": "…", "houseNumber": "…"
      },
      "position": {"lat": 51.5163, "lng": -0.0832},
      "access": [{"lat": 51.5164, "lng": -0.0831}],   // snap point on a navigable link
      "distance": 0,                                   // metres, as the crow flies
      "mapView": {"west": -0.09, "south": 51.51, "east": -0.07, "north": 51.52},
      "scoring": {"queryScore": 1.0, "fieldScore": {"streets": [], "houseNumber": 1.0}},
      "navigationAttributes": {
        "access": {"automobiles": true, "trucks": true, "deliveries": true,
                   "throughTraffic": true, "buses": true, "taxi": true}
      }
    }
  ]
}
```

**Real captured response** `[LIVE]` — `GET /v1/geocode?q=Trafford Park&in=countryCode:GBR&lang=en-GB&limit=1`:
```json
{"items":[{
  "title":"Trafford Park, Manchester, England, United Kingdom",
  "id":"here:cm:namedplace:20344256",
  "resultType":"locality",
  "localityType":"district",
  "address":{"label":"…","countryCode":"GBR","…":…,"postalCode":"M17 1"},
  "position":{"lat":53.46813,"lng":-2.30835},
  "mapView":{…},
  "scoring":{"queryScore":1.0,"…":…}}]}
```
Note: a district query returns `resultType:"locality"` with `localityType:"district"` (not `address`) — the MCP server must not assume `resultType=="address"`.

#### 3.1.2 Reverse geocode — `GET https://revgeocode.search.hereapi.com/v1/revgeocode`
**Required:** `at` **XOR** `in=circle:{lat},{lng};r={metres}` (mutually exclusive).
Optional: `limit` (1–100, **default 1**), `lang`, `types` (`address, area, city, houseNumber, place, street` — no `postalCode` here), `bearing` (0–359; forces `street` results), `show`, `showMapReferences`, `showNavAttributes`, `showRelated`, `politicalView`.
**Response:** `{ "items": [ …same item shape as geocode… ] }` `[DOCS-SHAPE]`.

#### 3.1.3 Discover — `GET https://discover.search.hereapi.com/v1/discover`
**Required:** `q`. **This is the tool for "truck stop near me / services along my route".**
Key params: `at`, `in` (supports `countryCode:`, `circle:{lat},{lng};r=`, `bbox:{west},{south},{east},{north}`), **`route`** (BETA corridor search: Flexible Polyline, optional `;w={width_m}` default 1000 — 2–2,000 points, width ≤ 50,000 m), `limit` 1–100 default 20, `offset`, `ranking` (BETA), `mobilityMode`, `lang`, `politicalView`, `show`, `fuelStation[...]`/`evStation[...]` (BETA deepObjects).
⚠️ There are **no** `types` / `categories` / `chains` / `foodTypes` request params — express those **inside `q`**.
**Response** `[DOCS-SHAPE]`: `{"items":[{ "title","id","resultType","address":{…},"position":{…},"distance", "categories":[…],"chains":[…],"openingHours":[…],"contacts":[…],"references":[…],"fuelStation"… }], "offset","count","limit"}`.

#### 3.1.4 Autosuggest — `GET https://autosuggest.search.hereapi.com/v1/autosuggest`
**Required:** `q`. Params: `at`, `in`, `route` (BETA), `limit` 1–100 default 20, `offset`, **`termsLimit`**, `lang`, `politicalView`, `show`, `showMapReferences`, `mobilityMode`.
**Response** `[DOCS-SHAPE]`: `{"items":[{ "title","id","address","position","distance" } | {"term","replaces","start","end"}], "queryTerms":[…], "offset","count","limit"}` — items are `oneOf` entity-result and query-term-suggestion.

**UK example that will work once keyed:**
```bash
curl -s "https://geocode.search.hereapi.com/v1/geocode?q=BB1%204DB&in=countryCode:GBR&lang=en-GB&limit=1&showNavAttributes=access&apiKey=$HERE_API_KEY"
```

---

### 3.2 Routing v8 — `GET https://router.hereapi.com/v8/routes`

**Spec version 8.165.0** [DOCS: https://docs.here.com/routing/reference/routing-api-v8-calculateroutes.md]. `POST /v8/routes` also exists but *"only selected parameters are permitted in the POST body"* — **use GET for the MCP server**; use POST only for very long `via`/`avoid` payloads.

#### 3.2.1 ⚠️ `truck[...]` is DEPRECATED — use `vehicle[...]`
Verbatim: *"**NOTE:** The attribute `truck` is deprecated and should be replaced with `vehicle`."* The `Truck` and `Vehicle` schemas are **identical** in Routing v8 (31 properties), so `truck[height]` still works but is legacy. Matrix v8 is stricter: *"Do not use `truck` parameters and `vehicle` parameters in the same request."*
Deep-object style, exploded: `vehicle[height]=400&vehicle[grossWeight]=44000`.

#### 3.2.2 Full vehicle/truck profile (units as HERE defines them)

| Param | Type / unit | Range · default | Notes |
|---|---|---|---|
| `vehicle[height]` | int **cm** | 0–5000 | overall height, e.g. `400` = 4.00 m |
| `vehicle[width]` | int **cm** | 0–5000 | |
| `vehicle[length]` | int **cm** | 0–30000 | incl. all trailers |
| `vehicle[grossWeight]` | int **kg** | ≥0 | defaults to `currentWeight`, else 0 |
| `vehicle[currentWeight]` | int **kg** | ≥0 | defaults to `grossWeight`, else 0 |
| `vehicle[emptyWeight]` | int **kg** | ≥0 | |
| `vehicle[weightPerAxle]` | int **kg** | ≥0 | heaviest axle; **mutually exclusive** with `weightPerAxleGroup` |
| `vehicle[weightPerAxleGroup]` | string | `single:11000,tandem:18000` | groups `single,tandem,triple,quad,quint`; truck/bus/privateBus |
| `vehicle[axleCount]` | int | **2–255** | includes trailer axles |
| `vehicle[trailerCount]` | int | 0–255, default 0 | |
| `vehicle[trailerAxleCount]` | int | ≥1, must be **< axleCount** | tolls only |
| `vehicle[trailerLength]` | int **cm** | 0–2000 | |
| `vehicle[kpraLength]` | int **cm** | ≥0 | kingpin-to-rear-axle (CA/ID only) |
| `vehicle[payloadCapacity]` | int **kg** | ≥0 | |
| `vehicle[shippedHazardousGoods]` | comma list | `explosive, gas, flammable, combustible, organic, poison, radioActive, corrosive, poisonousInhalation, harmfulToWater, other, allhazardousGoods, explosiveFlammable` | ADR |
| `vehicle[tunnelCategory]` | enum | **`B`,`C`,`D`,`E`** (no `A`) | ADR 8.6.3 cargo code; routes only through *less* restrictive tunnels |
| `vehicle[tiresCount]` | int | 1–255 | |
| `vehicle[category]` | enum | `undefined` \| `lightTruck` | `lightTruck` exempts many truck laws |
| `vehicle[occupancy]` | int | ≥1 | HOV / occupancy tolls |
| `vehicle[licensePlate]` | string | `lastCharacter:{c}` | environmental zones |
| `vehicle[speedCap]` | number **m/s** | 1–70 | caps ETA (cannot lower) |
| `vehicle[speedCapPerFc]` | string | per functional class, 1.00–70.00 m/s | `FC1:25,FC2:30` |
| `vehicle[engineType]` | enum | `electric`,`pluginHybrid`,`internalCombustion` | toll calc |
| `vehicle[heightAboveFirstAxle]` | int **cm** | 0–5000 | tolls only |
| `vehicle[commercial]` | bool | default true for trucks | tolls/speed limits/delivery areas |
| `vehicle[type]` | enum | `Straight`\|`Tractor` | **deprecated** |
| `vehicle[hovOccupancy]` | int | ≥1 | **deprecated** → `occupancy` |
| EV/other | `frontalArea` (m², 0.5–50), `rollingResistanceCoefficient` (0.001–0.5), `airDragCoefficient` (0.1–1), `engineSizeCc` | | |

**Absent from v8 (do not implement):** `truck[limitedWeight]`, `truck[emissionType]`, `truck[isPavedRoadsAllowed]`, `truck[isTrailer]`, `truck[isTunnelCategoryAllowed]` — these are legacy v7/TruckRouting names with **zero occurrences** in the v8 spec. Emission class lives at **`tolls[emissionType]`**; `limitedWeight` survives **only** in the legacy Waypoint Sequence API (§3.5).

#### 3.2.3 Core routing params
- **Locations:** `origin`, `destination` (both required; `lat,lng` or `here:cm:namedplace:…`), `via` (repeatable; `passThrough=true|false`, plus `stopDuration`/`charging=`).
- **Time:** `departureTime`, `arrivalTime` — **mutually exclusive**. Both accept RFC 3339 `date-time` or `full-date`, or the literal **`any`**.
- **Mode:** `transportMode` = `car`,`truck`,`pedestrian`,`bicycle`,`scooter`,`taxi`,`bus`,`privateBus`,`networkRestrictedTruck` (last four Beta; `networkRestrictedTruck` **requires** `networkRestrictedTruck[permittedNetworks]` and rejects most truck params). `routingMode` = `fast`|`short` (default `fast`; `short` unsupported for bicycle/bus/pedestrian/privateBus/scooter/taxi/networkRestrictedTruck). `alternatives` = 0–6 (default 0).
- **Restrictions:** `avoid`, `allow`, `exclude` (see below).
- **Output:** `return`, `spans`, `units` (`metric` default / `imperial`), `lang` (BCP-47 array, default `["en-US"]` → **use `en-GB`**), `currency` (ISO 4217 → **`GBP`**), `tolls`, `traffic`, `maxSpeedOnSegment`, `billingTag`, header `X-Request-ID`.

#### 3.2.4 `avoid` / `allow` / `exclude`
- **`avoid[features]`** (comma list): `seasonalClosure`, `tollRoad`, `controlledAccessHighway`, `ferry`, `carShuttleTrain`, `tunnel`, `dirtRoad`, `difficultTurns` (deprecated, truck-only), `uTurns`.
- **`avoid[areas]`** — ⚠️ **not WKT**. Pipe-separated list, **max 20** items / **250** total areas. Forms: `bbox:{west},{south},{east},{north}`; `polygon:{lat},{lon};{lat},{lon};…` or `polygon:{flexiblePolyline}`; `corridor:{lat},{lon};…;r={radius_m}`. A `!` prefix marks an exception (an allowed area inside an avoided one).
- Also: `avoid[segments]` (≤1,000 penalised segments, `here:cm:segment:ID#+|-|*`), `avoid[zoneCategories]` (`vignette`, `congestionPricing`, `environmental`, with `;exceptZoneIds=`), `avoid[zoneIdentifiers]`, `avoid[truckRoadTypes]` (e.g. `BK1,BK2`), `avoid[tollTransponders]` (value `all`).
- **`allow[hov]`, `allow[hot]`** booleans (default false). **`exclude[countries]`** (ISO-3), **`exclude[states]`** (`USA:NY,PA|CAN:QC`), `exclude[areas]`.

#### 3.2.5 `return` (18 values)
`polyline`, `actions`, `instructions`, `summary`, `travelSummary`, `turnByTurnActions`, `mlDuration` (**deprecated, returns nothing**), `typicalDuration`, `elevation`, `routeHandle`, `passthrough`, `incidents`, `routingZones`, `truckRoadTypes`, `tolls`, `routeLabels`, `potentialTimeDependentViolations`, `noThroughRestrictions`.
**Enforced dependencies:** `actions`→`polyline`; `instructions`→`actions`; `turnByTurnActions`→`polyline`; any `spans`→`polyline`. Violations are `E605013`/`E605017`.
**`spans`** (31 values) incl. `truckAttributes`, `streetAttributes`, `names`, `length`, `duration`, `baseDuration`, `typicalDuration`, `countryCode`, `stateCode`, `functionalClass`, `routeNumbers`, `maxSpeed`, `dynamicSpeedInfo`, `segmentRef`, `routingZones`, `truckRoadTypes`, `notices`, `incidents`, `tollSystems`, `gates`, `railwayCrossings`, `noThroughRestrictions`, `hovAttributes`.

#### 3.2.6 ✅ departureTime and traffic-awareness — the definitive answer
Verbatim [DOCS, `departureTime`]:
> "The requested time is converted to local time at origin. When the optional timezone offset is not specified, time is assumed to be local. The special value `any` can be used to indicate that time should not be taken into account during routing. **If neither `departureTime` or `arrivalTime` are specified, current time at departure place will be used.** … **Note**: Only long-term traffic incidents will be used if `departureTime=any` and `traffic[mode]=default` or no `traffic[mode]` are specified."

Verbatim [DOCS: https://docs.here.com/routing/docs/routing-v8-traffic-in-routing.md]:
> "**Time-aware route calculation is activated when either `departureTime` or `arrivalTime` is set to a specific time instance (not `any`), or neither of them is specified.** … **Traffic is enabled by default in time-aware route calculations.** … **To disable time-aware route calculation, specify `departureTime=any`.** This is referred to as 'planning mode' … with the exception of long-term closures. … To disable long-term closures use `traffic[mode]=disabled`."

**So: yes — v8 is traffic-aware by default; passing a real `departureTime` makes it *departure-time* traffic-aware. `departureTime=any` is the opt-out (planning mode).** `traffic[mode]` = `default`|`disabled`; `traffic[overrideFlowDuration]` (seconds) exists but is discouraged.

#### 3.2.7 Response `[DOCS-SHAPE]`
```json
{
  "notices": [{"title": "…", "code": "noRouteFound", "severity": "critical"}],
  "routes": [{
    "id": "46a98eca-…",
    "routeHandle": "…",                       // NOT for persistent storage
    "routeLabels": [{"name": "route1 via A4"}],
    "sections": [{
      "id": "…", "type": "vehicle",           // vehicle | pedestrian | transit
      "departure": {"time": "2026-11-02T08:30:00+00:00", "place": {"location": {"lat": 51.5, "lng": -0.12}, "type": "place"}},
      "arrival":   {"time": "…"},
      "summary": {
        "duration": 198,                      // seconds (int)
        "length": 1894,                       // metres (int)
        "baseDuration": 171,                  // free-flow, no time-aware info
        "typicalDuration": 183,               // typical for that time of day
        "tolls": {"total": {"type": "value", "currency": "GBP", "value": 4.5}},
        "co2Emission": 0.42
      },
      "travelSummary": { },
      "polyline": "A05xgKuy2xCx9B7vUl0…",     // Flexible Polyline, WGS84
      "actions": [{"action": "depart", "duration": 0, "length": 0, "instruction": "Head east", "offset": 0}],
      "spans": [ ], "incidents": [ ], "tollSystems": [{"name": "…"}],
      "tolls": [{"tollSystems": [0], "countryCode": "GBR",
                 "fares": [{"id": "…", "price": {"type": "value", "currency": "GBP", "value": 4.5},
                            "reason": "toll", "paymentMethods": ["cash"]}]}]
    }]
  }]
}
```
### 3.2.8 Live-captured response (working key, Manchester → Leeds, truck) `[LIVE]`

Real request (this is the canonical HGV call the MCP server should mirror):
```
GET https://router.hereapi.com/v8/routes
  ?transportMode=truck
  &origin=53.4808,-2.2426&destination=53.7632,-2.7031
  &return=summary,polyline
  &vehicle[height]=420&vehicle[grossWeight]=44000&vehicle[axleCount]=5
  &units=metric&lang=en-GB&currency=GBP
```
**✅ Both `truck[...]` and `vehicle[...]` are accepted; `vehicle[...]` is the v8 form — use `vehicle[...]`.**
> ⚠️ The commonly-copied list ends with `vehicle[emissionType]` and `vehicle[limitedWeight]`. **Neither exists in the v8 schema** (§3.2.2 — legacy v7 names, zero occurrences). HERE does not reject unknown query params, so they are silently ignored, which *looks* like acceptance. **Use `tolls[emissionType]` for emission class; there is no v8 `limitedWeight`** (it survives only in Waypoint Sequence, §3.5).

**Real response top level:** `{ "routes": [ { "id": …, "sections": [ … ] } ] }`

**Real `sections[0]` keys:** `id, type, actions, departure, arrival, summary, polyline, language, transport, tolls, tollSystems`

**Real `summary` — note exactly three fields, and NO traffic/delay field:**
```json
{"duration": 3264, "length": 56293, "baseDuration": 3107}
```
⇒ **delay must be derived: `duration - baseDuration`** (= 157 s here). There is **no `trafficTime`, `trafficDelay` or `typicalDuration` field** unless you ask for it — confirm in the builder's shaping. With `departureTime=2026-11-03T07:30:00+00:00` the same route returned `{"duration":3530,"length":56506,"baseDuration":3042}` → **traffic-aware, and `baseDuration` itself shifts with departure time** (the free-flow baseline is time-of-day dependent), so never treat `baseDuration` as a constant.

**Real `actions[]`** (`return=actions`/`instructions`; 33 of them for 56 km, localised by `lang=en-GB`):
```json
[{"action":"depart","duration":28,"length":40,
  "instruction":"Head toward Chancery Lane on Brown Street. Go for 40 m.","offset":0}]
```

**Real `tolls[]`** (`return=tolls&currency=GBP`) — **directly relevant to UK HGV**: the UK HGV Levy is returned as a toll:
```json
[{"countryCode":"GBR","tollSystemRef":0,"tollSystem":"UK HGV LEVY ENGLAND","tollSystems":[0],
  "fares":[{"id":"…","name":"UK HGV LEVY ENGLAND",
            "price":{"type":"value","currency":"GBP","value":10.36},
            "convertedPrice":{…},"reason":"toll",
            "paymentMethods":["bankCard","creditCard","passSubscription",…]}]}]
```
This confirms `currency=GBP` works and that **the UK HGV Levy is priced per route** — a genuine HGV value-add for the MCP server. Note the extra fields `tollSystem` (string name), `tollSystemRef` and `convertedPrice` appear in practice.

Semantics recap: `duration` **int seconds**, `length` **int metres**. Polyline is **Flexible Polyline** (`github.com/heremaps/flexible-polyline`), not Google-encoded. `routeHandle` is explicitly *"not suitable for persistent route storage! It can be invalidated at any time."*

**Tolls:** require `return=tolls`; `tolls[...]` params are invalid without it. Per-section `tolls[]` + `summary.tolls` (`tolls[summaries]=total|tollSystem|country`; **`total` requires `currency`**). Price object: `{type:"value"|"range", currency, value, estimated}`. If unavailable → notice `tollsDataUnavailable`. `tolls[emissionType]` = `euro1…euro6`, `euroEev`; `tolls[transponders]`, `tolls[vignettes]`.

---

### 3.3 Matrix Routing v8 — `POST https://matrix.router.hereapi.com/v8/matrix`

**Async by default** (`async=true`); body limit 10 MiB. Required: **`origins`**, **`regionDefinition`**. Also `destinations`, `profile`, `departureTime`/`arrivalTime`, `routingMode`, `transportMode`, `avoid`/`allow`/`exclude`, `vehicle` (or deprecated `truck`), `ev`, `matrixAttributes`, `traffic`, `violationMapping`.

**Async flow** [DOCS: postmatrix-1.md, getmatrixstatus-1.md, getmatrix-1.md] — note the identifiers:
1. `POST /v8/matrix?async=true` → **202** `{"matrixId":"bc79a808-…","status":"accepted","statusUrl":"https://routing-matrix-region-1.router.hereapi.com/v8/matrix/bc79a808-…/status"}`
2. `GET {statusUrl}` → **200** `MatrixStatus` (`accepted` → `inProgress` → `completed` | `timeout` | `error`); **303 redirect** to the result when complete.
3. `GET /v8/matrix/{matrixId}` → **200** `MatrixResponse`, or 303.
- `async=false` → **200** inline.
- ⚠️ **Use the returned `statusUrl`, not the base host** (it is region-specific; using the base host yields 404). API-key clients must **forward `apiKey` across the 303**; Bearer clients must **not** forward `Authorization` to the redirect target (it is object storage).

**Truck support:** `vehicle` as a JSON **object** (28 properties = Routing v8's set **plus `weightLimit`**, **minus** `trailerAxleCount`, `heightAboveFirstAxle`, `hovOccupancy`, `engineType`). Mixing `truck` and `vehicle` is forbidden.

**Limits** [DOCS: matrix-v8-matrix-modes.md]:

| Mode | `regionDefinition` | `profile` | custom opts/live traffic | sync max | async max |
|---|---|---|---|---|---|
| Flexible | `world` | no | yes | 15×100 or 100×1 | 15×100 or 100×1 |
| Region | circle/boundingBox/polygon/autoCircle | no | yes | 500×500 | 10,000×10,000 |
| Profile | `world` | yes | no (free-flow only) | 500×500, 1×2000, 2000×1 | 10,000×10,000 |

`regionDefinition` is **always required**; region **diameter ≤ 400 km**; polygon ≤ 100 vertices. Result: `matrix.travelTimes[]` (s), `distances[]` (m) flat-indexed `k = numDestinations·i + j`, plus `errorCodes[]`.

**Live-captured async flow** `[LIVE]` — the exact sequence that works:
1. `POST https://matrix.router.hereapi.com/v8/matrix?apiKey=…` with body
   `{"origins":[{"lat":…,"lng":…}],"destinations":[{"lat":…,"lng":…}],"regionDefinition":{"type":"world"}}`
   → **202** `{"matrixId":"…","status":"accepted","statusUrl":"https://routing-matrix-region-1.router.hereapi.com/v8/matrix/<matrixId>/status"}`
2. `GET {statusUrl}` → when done `{"matrixId":"…","status":"completed","resultUrl":"…"}`
3. `GET {resultUrl}` **with `Accept-Encoding: gzip` and following the 303 to S3** (`curl --compressed -L`) → `{"matrixId":"…","matrix":{"numOrigins":1,"numDestinations":2,"travelTimes":[2851,2276]},"regionDefinition":{…}}`

> ⚠️ **`matrixAttributes` was rejected in the live v8 call** — sending it produced **400 `unknown variant …, expected travelTime|duration`**. **Omit `matrixAttributes`**; the response returns `travelTimes` (and `distances` when available) anyway. The v8 enum values are `travelTimes|distances|consumptions` if it ever accepts them — treat that as version-dependent and skip it.

**Quota evidence in response headers** `[LIVE]`: the result response carries
`usage: lama_matrix_tier1:1,origins:N,destinations:M` — a per-call billable-unit record. Log it if the operator wants usage accounting; it is the closest thing to a quota signal on the wire.

---

### 3.4 Isoline Routing v8 — `GET https://isoline.router.hereapi.com/v8/isolines`

`origin` **XOR** `destination`; `departureTime` with origin / `arrivalTime` with destination. **Truck-capable** (`transportMode=truck`, `vehicle` accepted; 29 props).

| Param | Values / limits |
|---|---|
| `range[type]` | **`distance`** (metres, max **1,000,000**) · **`time`** (seconds, max **32,400**) · `consumption` (EV Wh max 650,000; fuel ml/g max 40,000) |
| `range[values]` | comma list, e.g. `range[type]=time&range[values]=300,600,900` |
| `routingMode` | `fast`\|`short` (default `fast`) |
| `optimizeFor` | `quality`\|`performance`\|`balanced` (default) |
| `shape[maxPoints]`, `shape[maxResolution]` | detail control (recommended >100 points) |
| also | `avoid` (same 9 features), `allow`, `exclude`, `traffic`, `vehicle`, `ev`, `fuel`, `consumptionModel`, `billingTag` |

⚠️ **No `return`, `units`, `lang` or `currency` parameters exist on Isoline.**

**Response** `[DOCS-SHAPE]`: `{notices[], departure?, arrival?, isolines:[{range:{type,value,consumptionType?}, polygons:[{outer:"<flexpolyline>", inner:["<flexpolyline>"]}], connections:[{fromPolygonIndex,toPolygonIndex,polyline}]}]}` — `outer`/`inner` are **encoded Flexible Polylines**, not GeoJSON rings.

**Real captured response** `[LIVE]` — truck, `range[type]=time&range[values]=1800` → one polygon:
```json
{"departure":{…},
 "isolines":[{"range":{"type":"time","value":1800},
              "polygons":[{ "outer":"<flexpolyline>", "inner":[…]} ]}]}
```
⇒ the builder must decode `outer`/`inner` with the Flexible Polyline decoder (tool #14) to produce GeoJSON for any map UI.

---

### 3.5 Waypoint Sequence v8 — `GET https://wps.hereapi.com/v8/findsequence2`

⚠️ **Completely different, legacy parameter grammar** — no `vehicle[...]`/`truck[...]`; truck data is flat params with **unit-suffixed strings**. (`POST` form-urlencoded variant exists.)

| Param | Req | Detail |
|---|---|---|
| `start` | ✅ | `Name;lat,lng` |
| `end` | – | optional but recommended; supports `st:`, `at:`, `acc:`, `heading:`, `sideOfStreetHint:` |
| `destinationN` | ✅ (`destination0` first) | **max 202 waypoints** incl. start/end; **max 50 per road segment** |
| `mode` | ✅ | `Type;TransportModes;TrafficMode;Feature:-N,…` — `fastest`\|`shortest`; `car,truck,bicycle,scooter,taxi,bus,pedestrian`; `traffic:enabled`\|`traffic:disabled`; features `tollroad, motorway, boatFerry, railFerry, tunnel, dirtRoad` scored 0…-3 |
| `departure` | – | dateTime or `now` |
| `improveFor` | – | **`distance` \| `time`** only (default `time`) — there is **no `travelTime`** |
| `height`, `width`, `length` | – | unit-suffixed strings: `400cm` / `4m` / `157in` |
| `limitedWeight` | – | `7.5t` / `7500kg` / `16500lbs` — **exists only in this legacy API** |
| `weightPerAxle` | – | **kg only, no suffix** |
| `trailersCount` | – | 0–4 (`4` = semi-trailers, **not supported for WPS**) |
| `truckType` | – | `truck`\|`tractorTruck` |
| `shippedHazardousGoods` | – | `explosive, gas, flammable, combustible, organic, poison, radioActive, corrosive, poisonousInhalation, harmfulToWater, other` — ⚠️ `allhazardousGoods`/`explosiveFlammable` **not** supported here |
| `tunnelCategory` | – | `B`,`C`,`D`,`E` |
| also | `avoidAreas` (≤20 bboxes), `avoidSegments`, `avoidUTurns`, `excludeCountries`, `restTimes`, `breakTimes` (≤5), `clustering` (5–50,000 m), `driverCost`, `vehicleCost`, `jsonCallback`, `requestId` | |

`destinationN` grammar: `[ID;]lat,lng[;st:{secs}[,interruptible:{true|false}]][;acc:openingHours | ;at:appointment][;before:destinationN][;sideOfStreetHint:[matchSideOfStreet,]lat,lng]`.
**Response** `[DOCS-SHAPE]`: `{"results":[{ "waypoints":[{"id","lat","lng","sequence","estimatedArrival","estimatedDeparture","fulfilledConstraints":[],"cluster"}], "distance":"…", "time":"…", "interconnections":[…], "timeBreakdown":{…} }], "errors":[], "warnings":[], "processingTimeDesc":"…", "responseCode":"…", "requestId":"…"}` — `results` has 0 or 1 element, and **`distance`/`time` are strings**, not numbers.

---

### 3.6 Traffic v7 — `https://data.traffic.hereapi.com/v7/{incidents,flow}`

**Required on both:** `in`, `locationReferencing`.

`in` forms: `circle:{lat},{lng};r={m}` · `bbox:{west},{south},{east},{north}` · `corridor:{flexiblePolyline};r={m}` · `segmentRef:{refs};rr={refReplacements}` (≤100 refs).
`locationReferencing`: `none | olr | shape | tmc | segmentRef` (comma-separated multi, e.g. **`olr,shape`**).

**Optional:** `criticality` (`low,minor,major,critical`), `type` (`accident, construction, congestion, disabledVehicle, massTransit, plannedEvent, roadHazard, …`), `functionalClasses` (1–5), `earliestStartTime`/`latestEndTime` (RFC 3339 UTC), `lang`, `units`, `useRefReplacements`, `exactSegmentRefMatching`.
**`/flow` adds:** `minJamFactor` (0.0–10.0, default 0.0), `maxJamFactor` (0.0–10.0, **default 1.0** — raise it or you filter out congestion), `advancedFeatures`.
⚠️ There is **no `maxresults`, `limit`, `status`, `codes` or `language`** request param — language is `lang`; `codes` is response-only.

**Documented hard limits:** circle radius **≤ 50 km**; bbox **≤ 1 degree** per side; corridor **≤ 300 points, ≤ 500 km, radius ≤ 5 km**; use POST when the corridor polyline would exceed the ~1000-char URI limit. Events match by *bounding-box intersection*, so slightly-outside results can appear.

**✅ `/flow` — the 400 "Malformed request" trap, resolved** `[LIVE]`: `locationReferencing` is **mandatory on `/flow` too**, and it is easy to omit when copying an incidents URL. Omitting it returns **400 `code:E608051`, `cause: parameter 'locationReferencing' is missing`**. The working call is:

```
GET https://data.traffic.hereapi.com/v7/flow
  ?in=bbox:-2.4,53.4,-1.4,53.9
  &locationReferencing=olr
  &maxJamFactor=10
  &apiKey=…
→ 200, 3,162 results for that bbox
```
`locationReferencing=tmc` and `shape` also work. **Always send `maxJamFactor=10`** unless deliberately filtering — HERE's default of `1.0` hides most congestion.

**Real `/flow` result shape** `[LIVE]`:
```json
{"sourceUpdated":"…",
 "results":[{"location":{"description":"…","length":…,"olr":"…"},
             "currentFlow":{"speed":…,"speedUncapped":…,"freeFlow":…,
                            "jamFactor":…,"confidence":…,"traversability":…}}]}
```

**Real `/incidents` result shape** `[LIVE]` (flat `results[]` — no `results[].incidents[]` nesting):
```json
{"sourceUpdated":"2026-11-02T20:25:06Z",
 "results":[{"location":{"length":169.0,"olr":"…"},
   "incidentDetails":{"id":"…","hrn":"here:traffic:incident:…",
     "startTime":"2026-09-17T23:00:00Z","endTime":"2026-11-18T23:59:00Z",
     "roadClosed":false,"criticality":"major","type":"construction",
     "typeDescription":{"value":"Road construction","language":"en-US"},
     "codes":[701],"description":{…},"summary":{…}}}]}
```
Note `hrn`, `codes` (Alert-C) and `typeDescription` are present in practice; `language` inside `typeDescription` is `en-US` even with `lang=en-GB` — don't depend on it for localisation.

**Incidents response** `[DOCS-SHAPE]` — **flat** `results[]` of `{location, incidentDetails}` (there is **no** `results[].incidents[]` nesting):
```json
{
  "sourceUpdated": "2026-11-02T20:00:00Z",
  "results": [{
    "location": {
      "description": "M6 northbound J4-J5",
      "length": 1200.0,
      "olr": "<base64 OpenLR>",
      "shape": {"links": [{"points": [{"lat": 52.4, "lng": -1.5}], "length": 300.0, "functionalClass": 1}]}
    },
    "incidentDetails": {
      "id": "…", "originalId": "…", "roadClosed": false,
      "criticality": "major",
      "type": "construction",
      "summary": {"value": "Lane closed for roadworks", "language": "en-GB"},
      "description": {"value": "…"}, "codes": [701],
      "startTime": "2026-11-01T06:00:00Z", "endTime": "2026-11-05T18:00:00Z",
      "vehicleRestrictions": [
        {"vehicleType": "lorry",
         "restrictionType": {"weight": {"weightType": "vehicleWeight", "value": {"greaterThan": 0.0}}}}
      ]
    }
  }]
}
```
`vehicleRestrictions[]` is **directly HGV-usable**: `vehicleType: lorry`, plus restriction types `size{dimension: width|height|length}`, `weight`, `occupancy`, `fuelType`, `equipmentType`, `trafficType`, `plateNumber`.

**Flow response** `[DOCS-SHAPE]`: `{sourceUpdated, results:[{location, currentFlow:{speed (m/s), speedUncapped, freeFlow, jamFactor (0–10; **10.0 = road closure**), jamTendency, confidence (0–1), traversability, subSegments, lanes}}]}`. `confidence`: >0.7 real-time, 0.5–0.7 historical, ≤0.5 speed-limit based.

**OLR vs TMC:** *"The TMC network does not cover all roads. When only TMC location referencing is requested, then some results may be filtered out…"* TMC uses pre-coded location tables (ISO 14819-2/-3); **OLR (OpenLR, ISO/TS 21219-22) can reference any roadway** and is generated dynamically. **Request `locationReferencing=olr` (or `olr,shape`) for UK depots/industrial estates and corridor matching.**

---

### 3.7 Map Image v3 — `https://image.maps.hereapi.com/mia/v3/{resource}/{projection}/{view}/{size}/{format}`

All five path segments required; `projection` = **`mc`** (Mercator).

**`view`** — one of:
- `center:{lat},{lng};zoom={z}` or `center:{lat},{lng};radius={metres}`
- `bbox:{west},{south},{east},{north}[;padding={px}]` — ⚠️ *"latitude and longitude values do not follow the same order (latitude is first) as compared with other API parameters"*
- `bounds:{lat},{lng},{lat},{lng}[,{lat},{lng}…][;padding={px}]`
- `overlay[:zoom=N|:radius=N|:padding=N]` — fit the view to the overlay content

**`size`** = `{width}x{height}` — **min 64, max 2048 px per dimension; max image 6 MB**. `format` = `jpeg`|`png`|`png8`. `padding` max = ¼ of the shorter dimension (800×600 → 150).

**Query params:** `apiKey` · `style` (default **`explore.day`**) · `ppi` (100/200/400) · `lang`/`lang2` · `pview` · `mv` · `features` · `copyright` · `cropLabels` · `scaleBar` · `scale` (2 = HiDPI) · `startTime`/`endTime` (only with `vehicle_restrictions` `active_only`/`active_and_inactive_differentiated`) · `geojson` · `overlay`.

**`features`** (comma-separated `name:mode`) — **the HGV levers**:
`vehicle_restrictions:active_and_inactive|permanent_only|active_and_inactive_differentiated|active_only|disabled` · `truck_preferred_roads:all|disabled` · `congestion_zones:all|disabled` · `environmental_zones:all|disabled` · `pois:all|disabled` · `public_transit:…`. Environmental/congestion zone coverage **includes the United Kingdom**. Live values: `GET /mia/v3/features`; formats/sizes: `GET /mia/v3/info`.

**⚠️ No `markers=`, `route=` or `polyline=` params** (those are Mia **v1** idioms). v3 draws with:
- **`overlay=`** — compact encoding: `geometryType ":" geometry [";" props] {"|" geometry…} ["|" globalProps]`; types `point|multiPoint|line|multiLine|polygon|multiPolygon`; `point = lat,lng`; **`line = (point {"," point}) | flexiblePolyline`**.
  Examples: `overlay=point:51.50995,-0.134496;label=A;size=large` · `overlay=line:<flexpolyline>;width=8;color=%230000FF`
  Only **one geometry type per `overlay` param** — repeat the param for mixed types. Escapes in labels: `\n`, `\;`, `\|`, `\\`.
- **`geojson=`** — full GeoJSON (**[longitude, latitude]** order).

**Marker style props:** `icon` (`pin` default; `cp`,`diamond`,`pin`,`poi`,`square`,`triangle`,`bubble`; `""` = label only), `label` (or auto `$alpha`/`$num`), `color`/`outline-color`/`text-color`/`text-outline-color` (`#rgb`,`#rrggbb`,`#rgba`,`#rrggbbaa`), `outline-width`, `size` (`small|medium|large`), `style=circle`, `width`, `layer=foreground`.

**Limits:** GET URL **max 8,192 chars** → use POST with geometry in the body (`Content-Type: application/geo+json` for GeoJSON, `text/plain` for compact overlay; caps **7 MB / 1 MB**; path uses bare `overlay` in the view slot). Encode `#` as `%23`. Max marker count: not documented [UNVERIFIED].

**So a static map with a truck route + markers =**
```
https://image.maps.hereapi.com/mia/v3/base/mc/overlay/800x600/png
  ?style=explore.day
  &overlay=line:<flexpolyline-from-routing>;width=8;color=%230000FF
  &overlay=point:51.5074,-0.1278;label=Depot;size=large;color=%23FF0000
  &features=vehicle_restrictions:active_only,truck_preferred_roads:all
  &lang=en-GB&apiKey=$HERE_API_KEY
```

---

## 4. UK / GBR HGV semantics

**Encoding & locale (all APIs):**
| Concern | Value | Where |
|---|---|---|
| Units | `units=metric` (v8 default is already `metric`) | Routing v8, Traffic v7 |
| Currency | `currency=GBP` (ISO 4217) — *"Costs for the calculated route will be returned using this currency"*; toll `total` summary **requires** `currency` | Routing v8, `tolls` |
| Language | `lang=en-GB` (routing default is `en-US`; pass `en-GB` explicitly) | Routing, Search, Traffic |
| Country filter | `in=countryCode:GBR` (uppercase ISO-3166-1 **alpha-3**) | Geocode, Discover, Autosuggest |
| Left-hand traffic | surfaced via span attribute `streetAttributes` → `rightDrivingSide` (false for GB) — useful sanity check | Routing `spans` |
| Postcodes | HERE handles full UK postcodes as `postalCodePoint` results; for a partial postcode pass it in `q` and read `postalCodeDetails` | Geocode `show=postalCodeDetails` |

**Truck-restriction handling — where HGV constraints actually live:**
1. **Routing `vehicle[...]` profile** (§3.2.2) is the *only* place dimensions/weights change the road graph. Defaults are 0/unset — **if you omit the profile, HERE will happily route a 44-tonner down a 7.5 t lane.** Always send at least `height`, `width`, `length`, `grossWeight`, `axleCount` and (if relevant) `weightPerAxle`, `trailerCount`, `shippedHazardousGoods`, `tunnelCategory`.
2. **`avoid[zoneCategories]`** = `congestionPricing,environmental,vignette` → for London **ULEZ/LEZ** and the **congestion charge**. Use `avoid[zoneIdentifiers]` / `;exceptZoneIds=` for fine control.
3. **`avoid[truckRoadTypes]`** (`BK1,BK2…`) to keep off unsuitable HGV road classes; **`avoid[features]`** for `tollRoad` (M6 Toll, Dartford, Severn crossings), `ferry` (Irish Sea, Isle of Wight), `tunnel`, `dirtRoad`.
4. **Traffic `vehicleRestrictions[]`** (§3.6) returns lorry-specific weight/size/dimension restrictions on incidents — surface these to the driver.
5. **Map Image `features=vehicle_restrictions:…`** for a visual restriction layer.
6. **Geocode `showNavAttributes=access`** → `navigationAttributes.access.trucks` tells you whether the *destination itself* is truck-accessible (last-mile check before routing to a depot).

**UK-specific caveats (operational, not from HERE docs — flagged):**
- UK legal maxima commonly used as defaults: **44,000 kg** GCW (6-axle artic), **16.5 m** length, **2.55 m** width, height typically **≤ 4.0–4.95 m** depending on vehicle/bridges — [UNVERIFIED as HERE-documented values; treat as operator defaults to validate, not as HERE constraints]. Send them explicitly rather than relying on HERE defaults.
- `networkRestrictedTruck` transport mode is **Beta** and for named network operators only — **not** a general UK HGV mode; do not use it in the MCP server unless a specific permitted network is supplied.
- **Tolling is sparse in GB** compared with EU: expect many routes to return `tollsDataUnavailable` or zero fare; `tolls[emissionType]` (Euro classes) mainly matters for EU cross-border legs. Do not treat a missing toll as an error.
- **Cross-border**: for ROI/NI runs use `exclude[countries]` and per-country toll summaries; `currency=GBP` will convert costs.
- Map Image environmental/congestion-zone coverage list includes the UK, so ULEZ rendering is available there; Traffic OLR coverage on minor roads is the caveat for depot-level corridors — request `olr,shape`.

---

## 5. New AI abilities (HERE AI / agents / MCP) — what is real and what is reachable

### 5.1 ⭐ HERE Location Reasoning — a real, hosted MCP server (REST-reachable? **No — MCP/OAuth, not apiKey**)

HERE now ships its **own** location MCP server:

- **Endpoint:** `https://hlr.here.ai/mcp` — *"This is a Model Context Protocol (MCP) endpoint, not a web page. It responds to JSON-RPC requests…"* [DOCS: https://docs.here.com/location-reasoning/docs/hlroverview.md]
- **It is live** — verified [LIVE]:
  - `POST /mcp` (JSON-RPC `initialize`) → **401**, headers `www-authenticate: Bearer resource_metadata="https://hlr.here.ai/.well-known/oauth-protected-resource"`, body `{"error":{"message":"Missing or invalid Authorization header","code":-32001,…},"jsonrpc":"2.0"}`
  - `GET https://hlr.here.ai/.well-known/oauth-protected-resource` → **200** `{"authorization_servers":["https://account.here.com/mcp","https://account.api.here.com"],"resource":"https://hlr.here.ai/mcp"}`
- **Its OAuth server is real too** [LIVE: `https://account.api.here.com/.well-known/oauth-authorization-server/mcp`]:
  ```json
  {"issuer":"https://account.here.com/mcp",
   "authorization_endpoint":"https://account.here.com/mcp/authorize",
   "token_endpoint":"https://account.here.com/token",
   "registration_endpoint":"https://account.api.here.com/mcp/register",
   "token_endpoint_auth_methods_supported":["none"],
   "grant_types_supported":["authorization_code"],
   "response_types_supported":["code"],
   "code_challenge_methods_supported":["S256"]}
  ```
  → interactive **OAuth 2.1 + PKCE (S256)** with **Dynamic Client Registration (RFC 7591)**; token auth method `none` (public client). Docs: on first connect the client DCRs itself, then *"opens a browser window for you to sign in with your HERE account."*
- **Two ways in:** (a) browser sign-in from an MCP client (no API key at all); (b) **M2M bearer token** from `https://account.api.here.com/oauth2/token` — OAuth **2.1 `private_key_jwt`** (APP ID as `client_id` + a JWK you register, RSA ≥3072) *or* OAuth **2.0 HMAC-SHA256** with Access Key ID/Secret — with `RESOURCE = https://hlr.here.ai/mcp`. Session lifecycle: `initialize` (returns `Mcp-Session-Id`) → `notifications/initialized` → `tools/list` → `tools/call`.

**HERE's MCP tool inventory** [DOCS: https://docs.here.com/location-reasoning/docs/hlrtools-reference.md]:

| Category | Tools |
|---|---|
| Geocoding | `geocode`, `reverse-geocode` |
| Routing | `calculate-route`, `find-route-stops`, `matrix-routing` (tiers `base` 100×100 / `premium` 500×500·10,000) |
| Public transit | `public-transit-route` |
| Route import | `get-route-from-polyline` |
| Search | `discover` |
| Experimental | `find-places-near`, `find-places-far-from` |
| Traffic | `real-time-traffic` |
| Isolines | `isoline-route` |
| Map rendering | `data-visualization` (interactive map from GeoJSON / cached route ids) |

Sessions are stateful: tools return cached **route/isoline/route ids** that later tools (`find-route-stops`, `real-time-traffic`, `data-visualization`) consume.
Tool naming as exposed to a client is prefixed: **`hlr___<name>`** (e.g. `hlr___geocode`). The server also exposes MCP **resources** — `guardrails://location-reasoning-usage-policy`, `categories://here-places`, `spatials://here-lg` — and a prompt `hlr___secure_location_reasoning`; the examples load the policy resource + prompt into the system prompt, which is worth copying if we ever wrap HLR.
There is **no REST twin**: `GET https://hlr.here.ai/` returns `404 <UnknownOperationException/>`; `/mcp` is the only surface [LIVE]. Commercially it is sold as its own product — **AWS Marketplace** (`prodview-5hdq5s532zfrw`, *"one-month free trial … pay-as-you-go"*, *"Complete a one-time HERE Platform onboarding"*) or HERE sales — announced **14 Oct 2026**; **no public unit pricing**. [Observational caveat: docs say the bearer token is needed only for `tools/call`, but I measured `401` on `initialize` *and* `tools/list`, so the entitlement is enforced at the HTTP layer.]

> ### 🔑 The key finding for our project
> **HERE's own MCP has NO truck/HGV support.** A full-text scan of the entire tools reference for `truck|hgv|heavy|lorry|grossWeight|vehicle` returns **zero matches**. There is no vehicle-dimension parameter on any tool. An HGV navigation MCP server is therefore **genuinely additive** — it is not duplicating a shipped HERE capability, and the natural design is to *compose*: expose truck-aware tools that call HERE Routing v8 with the `vehicle[...]` profile, and optionally delegate map rendering to HERE's MCP.

### 5.2 HERE documentation MCP — open, no key, no auth

A second, separate MCP server: **`https://docs.here.com/mcp`** (streamable HTTP). It indexes HERE's docs **and its whole OpenAPI catalogue**:

| Item | Detail |
|---|---|
| Reachability | **Fully open — no API key, no OAuth** [LIVE: `POST` returns 200 with SSE and `serverInfo {"name":"HERE Technologies Documentation \| HERE Docs","version":"1.0.0"}`] |
| Required header | `Accept: application/json, text/event-stream` — omit it and you get **406** |
| Tools (7) | `search` (docs search → id/title/url), `fetch` (page by id `project/section/slug`), `list-specs`, `list-endpoints`, `get-endpoint`, `search-endpoints`, `get-server-variables` |
| Client config | `{"mcpServers":{"here-docs":{"type":"streamable-http","url":"https://docs.here.com/mcp"}}}` |
| Use for us | **Builder-time**, not runtime — a fast way to re-verify any HERE parameter against the live OpenAPI catalogue instead of trusting this document. |

It is *not* a location API. Its existence is the main "AI ability" that is trivially reachable today.

### 5.3 HERE AI Assistant — real product, **no public API**

Announced at **CES 2025**, *"leverages multiple Generative AI Large Language Models (LLMs)"* for in-vehicle conversational guidance. Crucially: *"built for seamless integration into passenger and commercial vehicle systems **via the HERE Navigation solution or HERE software development kit (SDK)**."* No developer documentation, no REST endpoint, no API key path — it is OEM/contact-sales only. [DOCS: https://www.here.com/about/press-releases/here-technologies-brings-ai-powered-mapping-and-software-defined-vehicle]
⚠️ Naming trap: **MapGPT is Mapbox's product, not HERE's** — do not conflate them in the write-up or in code comments.

### 5.4 Verified negatives (important for honesty)

These were checked, not assumed:
- **No embeddings / vector / semantic-search endpoint exists** anywhere in HERE's OpenAPI catalogue. Enumerated via the docs MCP: `search-endpoints pattern=embedding` → *"No matches found"*; `natural language` → no matches. Full-text search across all **37** doc projects for "semantic search", "embeddings", "LLM", "machine learning", "natural language" → **zero** results. "vector" matches only the **Vector Tile API** (map tiles, unrelated).
- **No generative route summarisation**, no "Tour Planning AI", no AI field in any location API response.
- **`discover` / `autosuggest` are deterministic IR**, not LLM: the query string is free text, e.g. `GET https://discover.search.hereapi.com/v1/discover?at=40.73,-73.99&q=Statue+of+liberty&apiKey={KEY}` — *"This request uses API key authentication."* Calling this "AI-powered search" would be marketing, not engineering.
- **No official `@here` MCP npm package.** npm has only third-party `@pipeworx/mcp-here`; Composio/IdeaBoxAI list third-party HLR wrappers. Official HERE GitHub AI repos are just `heremaps/here-location-reasoning-plugin` and `heremaps/here-location-reasoning-testing-prompts`.
- **HLR has no stdio transport** documented — remote HTTP only. **HLR unit pricing is not public** (PAYG via AWS Marketplace; *"one-month free trial"*, *"Complete a one-time HERE Platform onboarding"*). Announced **14 Oct 2026**; HERE's Marketplace copy states the boundary plainly: *"Unlike traditional SaaS or REST-based mapping APIs, HERE Location Reasoning is purpose-built for agentic consumption."*

### 5.5 How to consume HERE Location Reasoning (when we want it)

```json
{"mcpServers":{
  "here-location":{"type":"streamable-http","url":"https://hlr.here.ai/mcp"},
  "here-docs":{"type":"streamable-http","url":"https://docs.here.com/mcp"}}}
```
(from HEREmaps' official plugin repo). Session lifecycle: `initialize` (returns `Mcp-Session-Id`) → `notifications/initialized` → `tools/list` → `tools/call`. Docs claim a bearer token is needed only for `tools/call`, but **in practice the HTTP layer rejects even `initialize`/`tools/list` without auth** (measured), so live schema enumeration is not possible unauthenticated. Requires an **HLR entitlement** (AWS Marketplace subscription or HERE sales), not merely a REST API key.

### 5.6 Honest verdict table

| Capability | What it is | Reachable with a plain REST API key? | Access path | Source |
|---|---|---|---|---|
| **HERE Location Reasoning (HLR)** | Hosted remote MCP server wrapping HERE APIs as **13** agent tools | **No** — MCP only; OAuth 2.1 (`authorization_code`+PKCE / `private_key_jwt`) or OAuth 2.0 bearer, **plus an HLR entitlement** | `https://hlr.here.ai/mcp`; AWS Marketplace / HERE sales | hlr.here.ai + live metadata |
| **HERE documentation MCP** | MCP over HERE docs + OpenAPI catalogue, 7 tools | **N/A — no key at all** | `https://docs.here.com/mcp` | verified live |
| **HERE AI Assistant** | LLM in-vehicle conversational guidance | **No** — embedded via HERE Navigation / HERE SDK; no public API | OEM / contact sales | here.com press release (CES 2025) |
| HERE Studio | No-code/low-code custom map making | No REST for Studio itself; underlying Platform Data API is REST | Web UI / HERE Marketplace | here.com |
| "AI" in Geocoding & Search / Discover | Free-text `q` + Autosuggest — deterministic information retrieval | **Yes** (`apiKey`) — but **not** LLM/semantic | `discover.search.hereapi.com` | GS7 spec |
| Embeddings / vector / semantic search | — | **Does not exist** | — | negative, verified across catalogue |
| LLM-readable docs (`llms.txt`, `.md` per page) | Machine-readable documentation | **Yes** (public HTTP) | `https://docs.here.com/llms.txt` | verified live |
| Kiro Power / Wherobots / Composio | Third-party wrappers around HLR | No | partner platforms | Geo Week / AWS Marketplace |

**Bottom line for the user's "new AI abilities" question:** HERE has exactly **one** substantive shipped AI product with a programmatic interface — **HERE Location Reasoning**, a real, live MCP server — and it is reached over **MCP + OAuth + a separate entitlement**, *not* with a Location Services API key, and it has **no truck profile**. Everything else AI-branded around HERE's location REST APIs is either (a) ordinary free-text query parameters, or (b) the OEM-embedded **AI Assistant** with no public API. The verified absence of embeddings/semantic endpoints matters for the roadmap: **do not plan a "semantic search" feature on HERE — it would have to be built on top of `discover`/`geocode` plus our own ranking.**

---

## 6. Live validation results

### 6.1 The credential supplied in the request — invalid (all 401)

All calls made 2026-11-02 with the supplied credential. **HTTP status → entitlement verdict.**

| # | Service / endpoint called | Method | HTTP | Entitled with this credential? |
|---|---|---|---|---|
| 1 | `geocode.search.hereapi.com/v1/geocode` | GET | **401** | **No** — `apiKey invalid. apiKey not found.` |
| 2 | `revgeocode.search.hereapi.com/v1/revgeocode` | GET | **401** | No — same |
| 3 | `discover.search.hereapi.com/v1/discover` | GET | **401** | No — same |
| 4 | `autosuggest.search.hereapi.com/v1/autosuggest` | GET | **401** | No — same |
| 5 | `lookup.search.hereapi.com/v1/lookup` | GET | **401** | No — same |
| 6 | `router.hereapi.com/v8/routes` (truck) | GET | **401** | No — same |
| 7 | `matrix.router.hereapi.com/v8/matrix` | GET | **405** | Method not allowed (POST-only); with correct POST → **401** |
| 8 | `matrix.router.hereapi.com/v8/matrix?async=true\|false` | POST | **401** | No — same |
| 9 | `isoline.router.hereapi.com/v8/isolines` (truck) | GET | **401** | No — same |
| 10 | `wps.hereapi.com/v8/findsequence2` | GET | **401** | No — same |
| 11 | `data.traffic.hereapi.com/v7/incidents` (bbox, olr) | GET | **401** | No — same |
| 12 | `data.traffic.hereapi.com/v7/flow` (bbox, olr) | GET | **401** | No — same |
| 13 | `image.maps.hereapi.com/mia/v3/base/mc/center:…/800x600/png` | GET | **401** | No — same (JSON error body, not an image) |
| 14 | `weather.hereapi.com/v3/report` (sanity/noise check) | GET | **401** | No — same |
| 15 | `account.api.here.com/.well-known/oauth-authorization-server` | GET | **200** | n/a — public metadata |
| 16 | `account.api.here.com/.well-known/oauth-authorization-server/mcp` | GET | **200** | n/a — public metadata |
| 17 | `hlr.here.ai/mcp` (JSON-RPC initialize) | POST | **401** | Not with an API key — needs OAuth bearer (MCP works this way by design) |
| 18 | `hlr.here.ai/.well-known/oauth-protected-resource` | GET | **200** | n/a — public metadata |
| 19 | `repo.platform.here.com/artifactory/open-location-platform/` | GET | **200** | **Yes** — this is the *only* thing the token is entitled to (Maven artifacts) |
| 20 | same Artifactory URL, anonymous / bogus bearer | GET | 401 / 401 | control proving #19 is real auth, not public |

### 6.2 The working vault key — every service validated `[LIVE]`

A genuine Location Services key (`bca-btt-here-api-key`, 43 chars) was used for the calls below. This is the entitlement picture the implementation can rely on.

| Service | Call | HTTP | Result observed |
|---|---|---|---|
| Geocode v7 | `q=Trafford Park&in=countryCode:GBR&lang=en-GB&limit=1` | **200** | `items[0]` = Trafford Park, Manchester M17 1, `resultType:locality` |
| Reverse geocode v7 | `at` → Manchester city centre | **200** | 73-79 King Street, Manchester M2 4NG |
| Discover v7 | `q=fuel station&at=53.4808,-2.2426` | **200** | ASDA Express etc. |
| Autosuggest v7 | `q=M1` | **200** | suggestions returned |
| **Routing v8 (truck)** | Manchester → Leeds, `vehicle[height]=420&vehicle[grossWeight]=44000&vehicle[axleCount]=5` | **200** | **56.3 km, 3,264 s**, `baseDuration` 3,107 s → delay 157 s |
| Routing v8 (truck + departureTime) | same, `departureTime=2026-11-03T07:30:00+00:00` | **200** | **56.5 km, 3,530 s**, `baseDuration` 3,042 s — traffic-aware confirmed |
| Routing v8 (car + departureTime) | motorway run | **200** | 69.4 km, 75.8 min |
| Isoline v8 (truck) | `range[type]=time&range[values]=1800` | **200** | 1 polygon |
| **Traffic v7 incidents** | `in=bbox:-2.4,53.4,-1.4,53.9&locationReferencing=olr` | **200** | flat `results[]` with `incidentDetails` |
| **Traffic v7 flow** | same bbox + `locationReferencing=olr&maxJamFactor=10` | **200** | **3,162 results** |
| Waypoint Sequence v8 | `mode=fastest;truck` | **200** | `results`/`errors`/`warnings` envelope |
| **Matrix v8 (async)** | POST → statusUrl → resultUrl | **202 → 200 → 200** | `travelTimes:[2851,2276]` |
| Map Image v3 | `/mia/v3/base/mc/center:…/800x600/png` | **200** | real PNG bytes |

**Verdict: the key is entitled to the full Location Services surface we need** — Geocoding & Search v7, Routing/Matrix/Isoline/Waypoint Sequence v8, Traffic v7 and Map Image v3. Only **HERE Location Reasoning** stays out of reach, and that is by design (MCP + OAuth + separate entitlement, §5.1), not a key problem.

**Interpretation.** The 401s in §6.1 are a single failure mode, not fourteen: that credential is not an LSS API key. Proven by the random-key control returning a byte-identical 401, and by a *missing* key returning a *different* message (`No credentials found`). No 403/entitlement error was ever observed with it, so nothing could be concluded about subscriptions from that credential alone — §6.2 settles it with a real key. Item 7's 405 is a method artifact (matrix is POST-only).

**Unexpected findings worth flagging:**
1. The credential in the original request is a **HERE platform Maven Repository token**, not an API key — and it is *valid* (Artifactory 200 vs 401 for anonymous/bogus). It is simply scoped to artifact downloads, so it cannot be used for location services at all.
2. **No token-exchange path exists** — the OAuth server advertises only `client_credentials` + `private_key_jwt`; the project-id/secret pair does not authenticate (identical 401 to a random credential control).
3. HERE has a **live hosted MCP server** (`hlr.here.ai/mcp`) with a full OAuth 2.1 / DCR / PKCE stack — a significant 2026 capability that is *not* "REST reachable with an API key" (§5).
4. `matrix.router.hereapi.com/v8/matrix` answers **405** on GET (POST-only) — a useful liveness smoke signal even when auth fails.
5. Traffic `/flow` **silently hides congestion** two ways: `locationReferencing` is mandatory (omitting it → 400 `E608051`), and `maxJamFactor` defaults to **1.0**. Send both explicitly.
6. **Unknown parameters are silently ignored.** `vehicle[emissionType]` / `vehicle[limitedWeight]` do not exist in v8 yet appear to be "accepted"; `matrixAttributes` does the opposite and hard-fails with 400. Neither behaviour is predictable from the spec — verify every optional param against a live 200.

**Re-validation at any time** — one-liner per service; all should return 200 (key from vault alias `bca-btt-here-api-key`):
```bash
export HERE_API_KEY='<new key>'
curl -s -o /dev/null -w "geocode %{http_code}\n"   "https://geocode.search.hereapi.com/v1/geocode?q=BB1+4DB&in=countryCode:GBR&limit=1&apiKey=$HERE_API_KEY"
curl -s -o /dev/null -w "routing %{http_code}\n"   "https://router.hereapi.com/v8/routes?transportMode=truck&origin=53.4808,-2.2426&destination=53.7632,-2.7031&return=summary&vehicle%5BgrossWeight%5D=44000&vehicle%5Bheight%5D=400&units=metric&lang=en-GB&currency=GBP&apiKey=$HERE_API_KEY"
curl -s -o /dev/null -w "traffic %{http_code}\n"   "https://data.traffic.hereapi.com/v7/incidents?in=bbox:-2.5,53.3,-2.0,53.6&locationReferencing=olr&apiKey=$HERE_API_KEY"
```
(The routing call is a real UK HGV case: Manchester → M6/M58 area, 44 t, 4.00 m.)

---

## 7. Recommended MCP tool surface (implementation spec)

**Global conventions for every tool**
- Reads `HERE_API_KEY` from env; injects `apiKey` server-side — **never** accept a key from the model/tool args, and never echo it in errors.
- Defaults on every call: `units=metric`, `lang=en-GB`, `currency=GBP`, and a GB country filter where the API supports one.
- All distances **metres**, durations **seconds**, weights **kg**, dimensions **cm** (converted at the tool boundary — the model should be able to say "4 m" and "44 t"; the tool converts to HERE units and returns both).
- Normalise errors into one shape: `{ok:false, http_status, service, code?, message, action, correlationId?}` plus, for routing, surface **`notices[]`** even on HTTP 200.
- Backoff+retry on **429/503** (surge throttling lasts up to ~10 min); cap retries and return a clear message.
- Resolve `Flexible Polyline` **server-side** for `here_route_truck` (return a decoded coordinate array optionally) — the model cannot decode it reliably.

| # | Tool | Key params | Returns |
|---|---|---|---|
| 1 | `here_geocode` | `query` (→`q`), `structured` (→`qq` object), `at?`, `country_code="GBR"`, `limit=1..100`, `lang="en-GB"`, `include_truck_access=true` (→`showNavAttributes=access`) | `items[]`: title, id, resultType, address.label, position, access[0], distance, **`truck_accessible`** (from `navigationAttributes.access.trucks`) |
| 2 | `here_reverse_geocode` | `at` (or `radius`+`at`→`in=circle`), `limit=1..100`, `lang`, `types?` | `items[]` same item shape |
| 3 | `here_discover` | `query`, `at?`, `radius_m?` (→circle), `bbox?`, `along_route_flexpolyline?`+`width_m=1000` (→`route` BETA), `limit` | `items[]`: title, id, categories, chains, address, position, distance, openingHours |
| 4 | `here_autosuggest` | `query`, `at?`, `limit`, `lang` | `items[]` + `queryTerms[]` |
| 5 | **`here_route_truck`** ⭐ | `origin`, `destination`, `via[]`; **truck profile object** → `vehicle[height|width|length|grossWeight|weightPerAxle|axleCount|trailerCount|trailerAxleCount|shippedHazardousGoods|tunnelCategory|category|occupancy|licensePlate|commercial]`; `departure_time?` (omit = now, traffic-aware), `arrival_time?`, `routing_mode="fast"`, `avoid_features[]`, `avoid_areas[]` (bbox/polygon/corridor), `avoid_zone_categories[]` (ULEZ/congestion), `avoid_truck_road_types[]`, `return[]` (default `["summary","polyline"]`), `include_instructions`, `include_tolls`, `alternatives=0..6` | `routes[0]`: `distance_m`, `duration_s`, `base_duration_s`, **`traffic_delay_s = duration-baseDuration`**, `typical_duration_s`, `polyline` (encoded + decoded `coordinates[]`), `actions[]`/`instructions`, `spans[]` (truckAttributes, maxSpeed, functionalClass), `tolls{total,currency}`, `notices[]`; echoes the truck profile used |
| 6 | `here_route_summary_multi` | `origin`, `destinations[]` (→ repeated `destination` via waypoints or multiple calls) | per-destination distance/duration — thin wrapper over 5 or 7 |
| 7 | `here_matrix_truck` | `origins[]`, `destinations[]`, `profile="flexible\|region\|profile"`, `region_definition`, truck profile object, `attributes=["travelTimes","distances"]`, `departure_time?`, `async=true` | `matrix{t num×m}` travel times + distances + `errorCodes[]`; handles 202→`statusUrl`→303 polling internally, returns only final matrix |
| 8 | `here_isoline_truck` | `origin`, `range_type="time\|distance"`, `range_values[]` (e.g. `[900,1800,2700]`), `transport_mode="truck"`, truck profile object, `routing_mode`, `optimize_for` | `isolines[]`: range, `polygons[]` with **decoded** `outer`/`inner` rings (GeoJSON-ready) |
| 9 | `here_waypoint_sequence` | `start`, `end?`, `waypoints[]` (≤202 total), `improve_for="time\|distance"`, `departure?`, `mode` (`fastest`/`shortest`), truck params in **legacy units** (`height="400cm"`, `limited_weight="44t"`, `weight_per_axle=<kg>`, `trailers_count`, `ship_hazardous_goods[]`, `tunnel_category`) | ordered `waypoints[]` with `sequence`, `estimatedArrival`/`Departure`; `distance`/`time` (parse the **strings** to numbers); `warnings[]` |
| 10 | `here_traffic_incidents` | `area` (`bbox`\|`circle`\|`corridor` flexpolyline), `radius_m?`, `criticality[]?`, `type[]?`, `location_referencing="olr"` (default) or `"olr,shape"`, `earliest_start?`, `latest_end?` | `incidents[]`: id, type, criticality, `road_closed`, `description`, `start/end`, `length_m`, `shape.links[].points[]`, **`vehicle_restrictions[]` filtered to `lorry`** |
| 11 | `here_traffic_flow` | `area` (bbox/circle/corridor), `max_jam_factor=10.0` (**default raised from HERE's 1.0**), `min_jam_factor=0`, `location_referencing="olr"` | `segments[]`: `jamFactor`, `speed_mps`, `freeFlow`, `confidence`, `traversability`, `road_closure` (jamFactor==10) |
| 12 | `here_truck_restrictions` (composite, high value) | `at`/`area`/`route_flexpolyline` | Merged HGV-relevant picture: traffic `vehicleRestrictions[]` (lorry weight/size), nearby `vehicle_restrictions` map features flag, `navigationAttributes.access.trucks` for the point, and any `avoid[zoneCategories]`-relevant zone ids |
| 13 | `here_static_map` | `view` (`center`+`zoom`\|`bbox`\|`fit_to_overlay`), `size` (≤2048), `format`, `style`, `route_flexpolyline?`, `markers[]` (lat/lng/label/icon/color), `features[]` (`vehicle_restrictions:active_only`, `truck_preferred_roads:all`), `lang="en-GB"` | PNG/JPEG bytes + the exact URL used (for caching/debug); auto-switch to POST if URL >8,192 chars |
| 14 | `here_flexible_polyline_decode` (utility) | `polyline`, `precision=5` | `[[lat,lng],…]` + bounding box — keeps polyline decoding out of the model; used by 5/8/13 |

**Deliberate design decisions**
- **Truck profile is a first-class object** on tools 5, 7, 8, 9, 12 — that is the product's differentiator vs HERE's own MCP (which has none).
- Use `vehicle[...]` (**not** deprecated `truck[...]`) in Routing v8/Matrix/Isoline; keep legacy flat params **only** inside tool 9 (Waypoint Sequence) where that API requires them.
- Tool 9 must translate units (`"44t"` → `44000 kg` for `weightPerAxle`, `"400cm"` for height) — HERE's WPS wants unit-suffixed strings for dimensions but bare kg for `weightPerAxle`.
- Don't wrap HERE's Location Reasoning MCP: it is OAuth-only and truck-blind. If interactive maps are wanted later, call HERE's `data-visualization` via that MCP in parallel; our tool 13 covers static maps with a location API key.

---

## 8. Open items / do not assume

| Item | Status |
|---|---|
| Live 2xx sample payloads | **Captured** for geocode, routing (summary/tolls/actions), matrix, isoline, incidents, flow (§3, §6.2). Still worth snapshotting one full payload per endpoint into the MCP server's test fixtures. |
| Per-API monthly free volumes / QPS, HERE Base Plan figures | **UNVERIFIED** — pricing page is JS-rendered and the API references publish no numbers; confirm in the portal for the owning account. |
| Subscription/entitlement for each service | **Resolved** (§6.2): the vault key is entitled to Geocoding & Search v7, Routing/Matrix/Isoline/Waypoint Sequence v8, Traffic v7, Map Image v3. Not entitled to Location Reasoning (separate product). |
| Usage/Cost Management API reachable with an LSS app key | **Resolved: no** — `security: [{token: []}]` only, bearer JWT required, no API-key scheme (§2.3). Don't build quota-reading on the app key. |
| "HERE AI" / "HERE Assistant" as a public REST API | **Resolved: no public REST API.** AI Assistant is OEM/SDK-embedded (§5.3); the only programmatic AI surface is the Location Reasoning MCP. |
| Max marker count / pixel budget for Map Image v3 | **Not documented**; only 2048 px/side, 6 MB, 8,192-char URL, 7 MB/1 MB POST caps are documented. |
| `vehicle[]` + `truck[]` mixed in one Routing v8 GET | **Both accepted live**, but mixing is pointless and Matrix forbids it. **Send only `vehicle[...]`.** |
| `vehicle[emissionType]` / `vehicle[limitedWeight]` | **Do not send** — absent from the v8 schema; silently ignored. Use `tolls[emissionType]`; no v8 `limitedWeight` (§3.2.8). |
| `matrixAttributes` in Matrix v8 | **Do not send** — rejected live with 400 `unknown variant` (§3.3). |
| UK legal HGV maxima (44 t / 16.5 m / 2.55 m) | **Operator defaults, not HERE-documented** — validate with the operator before hard-coding. |

---

### Appendix — source URLs used

- Docs index (agent-readable): https://docs.here.com/llms.txt · Location Reasoning: https://docs.here.com/location-reasoning/llms.txt
- Credential type: https://docs.here.com/identity-and-access-management/docs/get-platform-repository-credentials.md
- API keys: https://docs.here.com/identity-and-access-management/docs/plat-using-apikeys.md · Apps: https://docs.here.com/identity-and-access-management/docs/manage-apps.md
- OAuth 2.0: https://docs.here.com/identity-and-access-management/docs/how-to-authorize-with-oauth-20.md · Token endpoint spec: https://docs.here.com/identity-and-access-management/reference/oauth-20-access-token-getoauth2accesstoken.md
- Limits/quotas: https://docs.here.com/policies/docs/limits-and-quotas.md · Rate-limit rules: https://docs.here.com/identity-and-access-management/docs/how-to-find-rate-limit-rules.md
- Geocoding & Search v7: https://docs.here.com/geocoding-and-search/reference/get_geocode.md (+ `get_revgeocode.md`, `get_discover.md`, `get_autosuggest.md`)
- Routing v8: https://docs.here.com/routing/reference/routing-api-v8-calculateroutes.md · Traffic in routing: https://docs.here.com/routing/docs/routing-v8-traffic-in-routing.md
- Matrix v8: https://docs.here.com/routing/reference/postmatrix-1.md (+ `getmatrixstatus-1.md`, `matrix-v8-matrix-modes.md`)
- Isoline v8: https://docs.here.com/routing/reference/isoline-routing-api-v8-calculateisolines.md
- Waypoint Sequence v8: https://docs.here.com/routing/reference/waypoints-sequence-api-findsequenceget.md
- Traffic v7: https://docs.here.com/traffic-api/reference/traffic-api-v7-getincidents.md (+ `...-getflow.md`, location-referencing concept page)
- Map Image v3: https://docs.here.com/map-rendering/reference/getimage.md (+ `image-properties.md`, `additional-map-features.md`, `custom-overlay.md`, `geojson-overlay.md`, `post-method.md`, `flexible-polyline.md`)
- Location Reasoning MCP: https://docs.here.com/location-reasoning/docs/hlroverview.md · …/hlrtools-reference.md · …/hlrconnection-guide.md · …/hlrgetting-started.md
- Location Reasoning config/plugin: https://github.com/heremaps/here-location-reasoning-plugin · marketplace: AWS Marketplace `prodview-5hdq5s532zfrw`
- HERE AI Assistant (CES 2025): https://www.here.com/about/press-releases/here-technologies-brings-ai-powered-mapping-and-software-defined-vehicle
- Documentation MCP: `https://docs.here.com/mcp` (no auth) · docs agent banner → `https://docs.here.com/llms.txt`
- Usage API v2: https://docs.here.com/usage/reference/getusagebyrealm.md · …/usage/docs/get-started.md
- Rate Limit Rules API v1: https://docs.here.com/identity-and-access-management/reference/rate-limit-rules-api-v1-getratelimitrulesme.md · guide: …/docs/how-to-find-rate-limit-rules.md
- HTTP status codes: https://docs.here.com/geocoding-and-search/docs/http-status-codes · IAM error codes: …/docs/error-messages · access-denial troubleshooting: …/docs/troubleshooting-access-denials
- Request tracing: https://docs.here.com/routing/docs/routing-v8-request-tracing.md · request construction: …/geocoding-and-search/docs/request-constructing.md
