# Chaldean Law (chaldeanlaw.com): lawyer directory with AI matching

An online directory of lawyers with:

- **Search**: keyword, practice area, city, state, language, free consultation, sorting and pagination.
- **AI lawyer match** (`/assistant`): visitors describe their legal matter in their own words. A Claude agent works out the practice area and location, searches the directory with tools, and recommends specific listings with a reason for each. Leads sent from these recommendations are tagged "AI match".
- **Lawyer accounts** (`/register`, `/dashboard`): lawyers sign up, edit their listing (bio, areas, fees, languages, photo, etc.), read inquiries, and run **AI profile update**.
- **AI profile research**: Claude searches the web (firm site, state bar, directories) for a lawyer and proposes field updates. A side-by-side review screen shows current and suggested values with sources. Nothing is saved until a person approves each field. Available to lawyers for their own listing (max 3 runs/hour) and to admins for any listing.
- **Sponsored placements**: rotating ads in four slots (home banner, search sidebar, profile sidebar, blog sidebar). Each ad has a schedule, a weight, and view/click tracking. There are also "Sponsored/featured" listings that sort first in search results.
- **Blog** (`/blog`) with Markdown posts, drafts and cover images.
- **Admin backend** (`/admin`): approve/suspend/verify lawyers, create lawyer logins, practice areas, ads, blog, inquiries, editable site content (hero text, disclaimer, About page), and admin users.

Stack: Node.js 22+, Express, EJS, SQLite (built-in `node:sqlite`, so there are no native modules), and the Anthropic SDK.

## Try it in GitHub Codespaces

On the repository page, click **Code → Codespaces → Create codespace**. The app installs, loads sample data and opens in a browser tab. Sign in with `admin@example.com` / `admin-demo-123` or `lawyer@example.com` / `lawyer-demo-123`. To turn on the AI features, add `ANTHROPIC_API_KEY` as a Codespaces secret before you create the codespace.

## Quick start

```bash
npm install
cp .env.example .env            # optional, but needed for AI features
ADMIN_PASSWORD='choose-one' npm run seed   # admin + practice areas + sample data
npm start                       # http://localhost:3000
```

Load `.env` with your process manager, or run `node --env-file=.env ...`. The seed prints the logins:

- Admin: `admin@example.com` / the `ADMIN_PASSWORD` you set (a random one is printed if you don't set it)
- Demo lawyer: `lawyer@example.com` / `lawyer-demo-123`

All sample lawyers are fictional. For production, run `node src/seed.js --no-demo` to create only the admin account and practice areas.

## AI configuration

Set `ANTHROPIC_API_KEY` to turn on Claude (model `claude-opus-5-5` by default; override with `CLAUDE_MODEL`).

- **Without a key**, the assistant still works using keyword matching, and AI research is disabled.
- Requests turn on server-side refusal fallbacks (`fallbacks: "default"`).
- The matching agent (`src/ai/agent.js`) gets three tools: `search_lawyers`, `get_lawyer_profile` and `recommend_lawyers`. It can only recommend IDs that exist in the database and are active. Its system prompt keeps it from giving legal advice and tells it to send emergencies to 911.
- Profile research (`src/ai/enrich.js`) runs in two steps:
  1. Web search and web fetch gather notes with source URLs.
  2. Structured JSON output turns those notes into proposed field values.
- Web content is treated as untrusted data, and every field needs human approval.

## Production checklist

- Set `NODE_ENV=production` and a long random `SESSION_SECRET`. Run behind HTTPS, which is needed for secure cookies.
- Back up `data/directory.db` and `public/uploads/`.
- Add email notifications for new inquiries and lawyer sign-ups. This isn't built in yet; inquiries appear in the dashboards.
- Payments for sponsored placements are not built in. Admins turn ads and featured listings on manually.
- Have the disclaimer and AI wording reviewed for the bar advertising and lawyer-referral rules in your jurisdictions.

## Importing your lawyers

Go to **Admin → Import lawyers**. Either paste a Google Sheets link (shared as "Anyone with the link → Viewer") or upload a CSV file. Then:

1. Check how the columns are matched and look at the preview.
2. Choose whether new listings go live right away or wait for review.
3. Optionally delete the sample data in the same step.

Importing the same sheet again updates existing lawyers instead of duplicating them; a lawyer counts as existing if the email matches, or the name and city match. There's a CSV template on that page.

## Visual editing

These admin tools change the site without code:
- **Edit page.** Signed-in admins see a "✎ Edit page" button on public pages. Click any outlined text, type, then **Save changes**.
- **Admin → Texts.** Every editable phrase in one list, including placeholders and dropdown labels, with a filter and "Restore" for the original wording.
- **Admin → Appearance.** Main and highlight colours, font pairing, logo, and the homepage background image, with a live preview. It is served as `/theme.css`.
- **Admin → Homepage.** Reorder, show or hide the homepage sections.
- **Blog editor.** A visual editor for headings, bold, lists, links and image uploads. Posts are stored as sanitized HTML; older Markdown posts still display and convert when edited.

## Social media and profile settings

- **Admin → Social media.** The site's Facebook, Instagram, LinkedIn, X, YouTube, TikTok and WhatsApp links, shown as footer icons. You can enter a full link or just a @username.
- **Lawyer social links.** Fields on the lawyer form, for both admins and lawyers, shown as icons on the profile. Imports pick them up from LinkedIn, Facebook, Instagram, Twitter/X, YouTube and TikTok columns.
- **Admin → Lawyer profiles.** Choose which details profiles show (phone, email, website, office, social icons, fees, education, contact form and more), and whether new inquiries are emailed to the lawyer and/or the admins.

## Inviting lawyers to claim their listings

Go to **Admin → Invitations**, or open a lawyer's edit page. Create a personal link for each lawyer, or for everyone without a login at once. A lawyer opens the link, sets a password and gets control of their listing. Each link works once, expires after 30 days, and is cancelled when you create a newer one.

To get the links to lawyers, any of these work:
- copy a link by hand;
- download all active links as a spreadsheet for a mail merge;
- set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` (see `.env.example`), and the site emails the invitations itself.

Set `PUBLIC_URL=https://chaldeanlaw.com` in production so links always use your domain.

## First start without a terminal

If the database has no users, the server creates the default practice areas and an admin account from `ADMIN_EMAIL` and `ADMIN_PASSWORD` on start-up. Change the password after your first login. Set `DATA_DIR` to keep the database and uploads outside the code folder.

## Deploying with cPanel Web Apps (current setup)

chaldeanlaw.com runs as a cPanel **Web App** named `chaldeanlaw`, built from this repository's `main` branch on Node 22.
- **Updating:** redeploy the app in cPanel. It pulls from GitHub, then runs `npm install` and `npm run start`.
- **Integrations:** the Anthropic API key and the SMTP email settings can be entered in **Admin → Integrations**, with test buttons; no cPanel access needed. Environment variables, if set, take priority.
- **Settings:** environment variables are set in the Web App's settings (`NODE_ENV`, `SESSION_SECRET`, `PUBLIC_URL`, `NOINDEX`, `ANTHROPIC_API_KEY`, and the SMTP variables).
- **NGINX caching must stay off** for this account (cPanel → NGINX Manager). When it was on, the proxy served one visitor's cached page, CSRF token included, to everyone. The app now also sends `Cache-Control: private, no-store`.
- **Do not set `DATA_DIR`** to a path in the home directory. Web Apps run in a container, so such a path lives inside the container and is wiped on every redeploy. The default `data/` and `public/uploads/` folders inside the app persist across redeploys; this was tested.

## Deploying on cPanel

Use **Setup Node.js App**. Set the application startup file to `app.cjs`, choose Node.js 22 or newer, and add the environment variables from `.env.example` in that screen. Then run `npm install` and `node src/seed.js --no-demo` from the app's virtual environment.

## Project layout

```
src/server.js        app setup, security headers, sessions
src/db.js            schema, settings
src/models.js        search and listing queries, ad rotation
src/routes/          public.js, auth.js, dashboard.js (lawyers), admin.js
src/ai/              client.js, agent.js (matching), enrich.js (research)
views/               EJS templates
public/              CSS, JS (chat UI), uploads
```
