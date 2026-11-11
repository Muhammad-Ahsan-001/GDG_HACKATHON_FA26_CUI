# GDG_HACKATHON_FA26_CUI

GDG Hackathon FA26 — COMSATS University Islamabad.

## Awaaz

Awaaz is a mobile-first PWA. Anyone, whether they can read or not, can report a local problem in Islamabad or Rawalpindi
by voice, photo or text. The AI turns reports into categorised, verified pins on a live map and alerts the right responders.
The build contract is in `docs/CONTRACT.md` and `docs/CONTRACT-1B.md`.

### SOS (women's safety)

SOS is a separate, silent emergency mode at `/sos`. Ways to start it:

- Hold the red SOS button on the map or the Me page for 1.5 s.
- Press a volume button 3 times within 2.5 s.
- Shake the phone 3 times (opt-in, set on the Me page).
- Use the "SOS" app-icon shortcut.

While SOS is on, the app records the microphone in 8-second chunks and checks each chunk for threats ("I'll kill you",
"maar dunga", "bachao", ...). When it hears one, or when the user presses "Send alert now", it sends the nearest police
team an urgent alert with the user's live location. The alert is logged in the user's "My SOS log". SOS never plays a
sound and never appears on the public map.

**Limitation:** browsers deliver the hardware volume keys only on some Android devices, and only while the app is open in
the foreground. Triggering SOS with the screen off or the app in the background needs a native wrapper (a TWA plus an
Android service). That is future work.

### Demo logins

Use the one-tap buttons on `/login`. All demo accounts share the `DEMO_PASSWORD` constant in `src/lib/demoAccounts.ts`.

| Account | Role |
| --- | --- |
| `police@awaaz.demo` | Police (receives SOS alerts) |
| `rescue1122@awaaz.demo` | Rescue 1122 |
| `fire@awaaz.demo` | Fire Brigade |
| `water@awaaz.demo` | Water Authority (WASA) |
| `shelter@awaaz.demo` | Shelter NGO |
| `foodbank@awaaz.demo` | Food Bank NGO |
| `health@awaaz.demo` | Health NGO |
| `admin@awaaz.demo` | Admin |
| `citizen1@awaaz.demo` … `citizen5@awaaz.demo` | Citizens |
