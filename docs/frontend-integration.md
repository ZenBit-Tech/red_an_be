# Frontend Integration Guide

## Overview

This document describes how a frontend app should integrate with the backend authentication and de-identification APIs.

- API base URL: `http://localhost:3000`
- Swagger docs: `http://localhost:3000/api`
- Auth strategy: magic link + JWT Bearer token

## Authentication Flow

### 1) Request magic link

Endpoint:

```http
POST /auth/magic-link
Content-Type: application/json
```

Request body:

```json
{
  "email": "user@example.com"
}
```

Success response:

```json
{
  "message": "Magic link sent"
}
```

### Persist entity statuses

Endpoint:

```http
PATCH /de-identification/entities/statuses
Content-Type: application/json
Authorization: Bearer <jwt-token>
```

Request body:

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "activeEntityIds": [
    "550e8400-e29b-41d4-a716-446655440010",
    "550e8400-e29b-41d4-a716-446655440011"
  ]
}
```

Semantics:

- IDs from `activeEntityIds` are persisted as active.
- All other entities in the same job are persisted as inactive.

Success response:

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "updatedCount": 4,
  "findings": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440010",
      "jobId": "550e8400-e29b-41d4-a716-446655440000",
      "category": "PERSON",
      "confidence": 98.7,
      "start": 8,
      "end": 16,
      "proxyType": "Hash",
      "systemStatus": "ACTIVE",
      "systemStatusReason": "ANALYZER_DETECTED",
      "userStatus": "ACTIVE",
      "userStatusReason": "USER_BULK_ACTIVATE",
      "source": "ANALYZER",
      "effectiveStatus": "ACTIVE",
      "isSyntheticEligible": true
    }
  ]
}
```

### Generate synthetic data table

Endpoint:

```http
POST /de-identification/synthetic/generate
Content-Type: application/json
Authorization: Bearer <jwt-token>
```

Request body:

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "text": "Patient John Doe, born 1980-05-15...",
  "count": 5,
  "outputFormat": "txt"
}
```

Supported `outputFormat` values:

- `txt`
- `pdf`

Success response:

```json
{
  "generationId": "550e8400-e29b-41d4-a716-446655440099",
  "columns": ["PERSON", "DATE & TIME", "AGE", "PHONE", "EMAIL"],
  "rows": [
    {
      "rowIndex": 1,
      "entities": {
        "PERSON": "Jane Smith",
        "AGE": "47",
        "PHONE": "555-55-555"
      }
    }
  ],
  "summary": {
    "totalRows": 5,
    "generatedAt": "2026-05-14T10:00:00.000Z",
    "framework": "GDPR_EU"
  }
}
```

Important behavior:

- `text` must match the original analyzed document for the `jobId` (hash + length validation).
- Only entities with persisted `effectiveStatus=ACTIVE` are used for synthetic generation.
- The returned `generationId` is required for the download and regenerate endpoints.

### Download synthetic archive (ZIP)

Endpoint:

```http
GET /de-identification/synthetic/:generationId/download
Authorization: Bearer <jwt-token>
```

Response:

- `200 OK`
- `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="synthetic-variants-<generationId>-<timestamp>.zip"`
- Binary ZIP payload.

### Regenerate synthetic data table

Endpoint:

```http
POST /de-identification/synthetic/:generationId/regenerate
Content-Type: application/json
Authorization: Bearer <jwt-token>
```

Request body:

```json
{
  "count": 5,
  "outputFormat": "txt"
}
```

Success response: same shape as **Generate synthetic data table** (`generationId`, `columns`, `rows`, `summary`).

### 2) Verify magic link and get access token

Endpoint:

```http
GET /auth/magic-link/callback?token=<magic-token>
```

Success response:

```json
{
  "accessToken": "<jwt-token>"
}
```

Store `accessToken` and include it in all de-identification requests:

```http
Authorization: Bearer <jwt-token>
```

## De-identification Endpoints

All endpoints below require `Authorization: Bearer <jwt-token>`.

### Analyze text

Endpoint:

```http
POST /de-identification/analyze
Content-Type: application/json
Authorization: Bearer <jwt-token>
```

Request body:

```json
{
  "text": "Patient John Doe, born 1980-05-15...",
  "framework": "GDPR_EU",
  "threshold": 0.85,
  "preserveStructure": true,
  "includeExternalRecognizers": true
}
```

Supported `framework` values:

- `HIPAA`
- `GDPR_EU`
- `GDPR_UK`

Success response:

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440001",
  "findings": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "jobId": "550e8400-e29b-41d4-a716-446655440001",
      "category": "PERSON",
      "confidence": 98.73,
      "start": 8,
      "end": 16,
      "proxyType": "Hash"
    }
  ]
}
```

### Build anonymized preview

Endpoint:

```http
POST /de-identification/preview
Content-Type: application/json
Authorization: Bearer <jwt-token>
```

Request body:

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "text": "Patient John Doe, born 1980-05-15...",
  "framework": "GDPR_EU",
  "activeIds": ["550e8400-e29b-41d4-a716-446655440010", "550e8400-e29b-41d4-a716-446655440011"]
}
```

Success response:

```json
{
  "anonymizedText": "[PERSON_1] was born on [DATE_SHIFTED_1]."
}
```

### Remote NLP health

Endpoint:

```http
GET /de-identification/remote-nlp/health
Authorization: Bearer <jwt-token>
```

Success response:

```json
{
  "configured": true,
  "reachable": true,
  "latencyMs": 31,
  "details": "ok"
}
```

## Dashboard Stats Endpoint

Endpoint:

```http
GET /de-identification/stats?period=last_7_days&timezone=Europe/Kyiv
Authorization: Bearer <jwt-token>
```

### Query parameters

- `period` (optional):
  - `today`
  - `last_7_days`
  - `last_14_days`
  - `month` (rolling 30 days)
- `timezone` (optional): IANA timezone from frontend user settings, for example `Europe/Kyiv`

If no parameters are provided, backend defaults to:

- `period=today`
- `timezone=UTC`

### Response shape

```json
{
  "meta": {
    "period": "last_7_days",
    "timezone": "Europe/Kyiv",
    "rangeStart": "2026-04-20 00:00:00",
    "rangeEndExclusive": "2026-04-27 00:00:00",
    "previousRangeStart": "2026-04-13 00:00:00",
    "previousRangeEndExclusive": "2026-04-20 00:00:00"
  },
  "summary": {
    "totalDocuments": 185,
    "entitiesDetected": 2471,
    "avgEntitiesPerDoc": 13.4,
    "successRate": 98.7,
    "trends": {
      "totalDocumentsPct": 12.0,
      "entitiesDetectedPct": 8.0,
      "avgEntitiesPerDocPct": 3.4,
      "successRatePct": 0.0
    }
  },
  "charts": {
    "complianceFrameworkUsage": [
      { "framework": "HIPAA", "count": 42, "percentage": 42.0 },
      { "framework": "GDPR_EU", "count": 28, "percentage": 28.0 },
      { "framework": "GDPR_UK", "count": 30, "percentage": 30.0 }
    ],
    "entityTypesDetected": [
      { "label": "PERSON", "value": 160 },
      { "label": "DATE_TIME", "value": 140 }
    ],
    "processingHistory": [
      { "date": "2026-04-20", "documents": 31, "entities": 522 },
      { "date": "2026-04-21", "documents": 27, "entities": 471 }
    ],
    "confidenceScoreDistribution": [
      { "bucket": "90-100%", "value": 356 },
      { "bucket": "80-90%", "value": 134 },
      { "bucket": "70-80%", "value": 82 },
      { "bucket": "60-70%", "value": 55 },
      { "bucket": "<60%", "value": 14 }
    ],
    "deIdentificationMethodUsage": [
      { "method": "Redact", "value": 205 },
      { "method": "Replace", "value": 151 },
      { "method": "Mask", "value": 88 }
    ]
  }
}
```

## Suggested Frontend API Client

Example with fetch:

```ts
type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token } = options;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`API ${response.status}: ${message}`);
  }

  return response.json() as Promise<T>;
}
```

Synthetic ZIP download example:

```ts
type DownloadSyntheticPayload = {
  jobId: string;
  text: string;
  count: number;
  outputFormat: 'txt' | 'pdf';
};

export async function downloadSyntheticVariants(
  payload: DownloadSyntheticPayload,
  token: string,
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/de-identification/synthetic`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Synthetic generation failed: ${response.status}`);
  }

  const blob = await response.blob();
  const contentDisposition = response.headers.get('content-disposition');
  const filenameMatch = contentDisposition?.match(/filename="(.+)"/i);
  const filename = filenameMatch?.[1] ?? 'synthetic-variants.zip';

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
```

## Common Error Cases

- `401 Unauthorized`: missing or invalid JWT token.
- `400 Bad Request`: invalid payload, invalid UUID, or invalid timezone.
- `500 Internal Server Error`: processing/analyzer failure.

## Frontend Checklist

- Save and refresh JWT token after magic-link callback.
- Send Bearer token for all `/de-identification/*` routes.
- Always send user timezone for stats.
- Handle empty chart arrays and zero-value summary gracefully.
- Build chart labels from backend response values rather than hardcoded assumptions.
