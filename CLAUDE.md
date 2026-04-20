# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lustiga Landet Booking Admin — a single-page admin interface for managing amusement park bookings. No build system, no framework, no dependencies. Pure HTML/CSS/vanilla JS served as static files.

## Running Locally

```sh
serve .
# or any static file server — just open index.html
```

Requires the `serve` npm package (`npm install -g serve`). Runs on http://localhost:3000 by default.

## Architecture

Everything lives in two files:
- **`index.html`** — all application logic in an inline `<script>` block. Handles auth, fetching, rendering, and updating bookings.
- **`style.css`** — all styles.

### API

REST API hosted on AWS API Gateway. Two environments toggled by commenting/uncommenting `API_BASE` in index.html:
- **Prod**: `https://eay07x2tc7.execute-api.eu-north-1.amazonaws.com/prod//llb/v1`
- **Dev**: `https://95gewohkpj.execute-api.eu-north-1.amazonaws.com/dev/llb/v1`

Key endpoints:
- `GET /slots` — available booking dates (no auth)
- `GET /bookings?admin=<pwd>` — list all bookings
- `PUT /bookings/<id>?admin=<pwd>` — update a booking (sends full booking object)

Auth is a simple admin password passed as query parameter.

### Booking Model

Fields: `bookingId`, `dateStr`, `timeStr`, `name`, `numberOfPeople`, `numberOfKids`, `email`, `status`, `created`

Valid statuses: `NEW`, `REMOVED`, `CHECKED_IN`

### UI Features

- Password-gated access
- Paginated table (10 per page) sorted by date ascending
- Text filter across all booking fields
- Inline editing via dropdowns: date (from available slots), time, adults, kids, status
- Modal overlay blocks UI during updates
- Stats counter (total / filtered) in top-right corner
