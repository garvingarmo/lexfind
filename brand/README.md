# Chaldean Law logo

The logo is the Chaldean flag emblem with the wordmark "CHALDEAN ⚖ LAW / DIRECTORY" (gold scales of justice
between the words; Cinzel lettering converted to
outlines). **The flag emblem must not be altered** — only scaled or positioned. Its geometry is in
`flag_emblem.py`, traced from the official flag artwork (red #DE0000, yellow #FFF000, blue #0241AB, white).

Files are generated into `public/brand/` (and PNGs into `public/icons/` and `public/brand/email-logo.png`):

```
pip install fonttools
python3 brand/make_logo.py      # SVG logos → public/brand/
node brand/render_png.mjs        # app icons, favicon fallback, email header PNG (needs Playwright)
```

| File | Used for |
|---|---|
| `chaldeanlaw-logo-horizontal.svg` | Website header |
| `chaldeanlaw-logo-horizontal-reverse-transparent.svg` | Website footer (dark), source of the email header PNG |
| `chaldeanlaw-logo-stacked(-reverse).svg`, `chaldeanlaw-logo-horizontal-reverse.svg` | Print, social media, documents |
| `chaldeanlaw-mark(-reverse).svg` | Emblem with padding (avatars) |
| `chaldeanlaw-emblem.svg` | Emblem alone; also `public/favicon.svg` |

The fonts in `fonts/` are Cinzel from Google Fonts (SIL Open Font License).
A logo uploaded in Admin → Appearance replaces the default logo on the website and in emails.
