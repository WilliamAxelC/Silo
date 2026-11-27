# Silo legal pages: research notes

Researched 23 November 2026. Revised the same day after three reviews and new facts from the operator (see "Revision 2" at the end).
Files: privacy.html and privacy-id.html ("PP"), terms.html and terms-id.html ("ToS"). The English and Indonesian pages use the same section numbers and anchors (`#id`), so every reference below applies to both. The Indonesian version is the one that applies.
This is a requirements checklist, not legal advice.

## 1. Google API Services User Data Policy (Limited Use)

Source: https://developers.google.com/terms/api-services-user-data-policy (Limited Use is under `#additional_requirements_for_specific_api_scopes`)

| Requirement | How it is met |
|---|---|
| Publish a privacy policy that fully documents how the app interacts with user data; list its URL in the OAuth client config. "Privacy Policy and all in-product privacy notifications should be accurate, comprehensive, and easily accessible." | PP `#google-drive` covers access, use, storage, limits, retention and revocation. URL https://cuang.dev/projects/silo/privacy/ goes in the consent screen config (operator action). |
| Use of Google user data limited to practices disclosed in the policy; notify and get consent before new uses. | PP `#drive-use` lists every use, including restore. PP `#changes`: "We will not start a new use of your data until you choose it in the app." |
| Limited Use 1: use only to provide or improve prominent user-facing features. | PP `#drive-use`: backup, restore, photo archive; email only to show the connected account; name and photo discarded (`#drive-access`). |
| Limited Use 2: no transfers except for user-facing features with consent, security, law, or merger with prior consent. | PP `#drive-sharing`: Silo does not send Google data to us; it leaves the phone or Drive only when the user sends it (external AI, bug report screenshot). |
| Limited Use 3: no human reading except with consent, security, law, or aggregated internal ops. | PP `#drive-storage`: Silo gives us no access to the user's Drive. |
| Prohibited: transfer or sale to ad platforms or data brokers; ads; credit-worthiness or lending. | PP `#drive-sharing` (never sold, never used for ads), PP `#not-do` (no credit or lending use). |
| "We expect all user data is secure in transit and at rest." | PP `#drive-access` (tokens held by Google Play services), PP `#security`. |
| Request only the scopes needed. | PP `#drive-access` lists all requested scopes: `openid`, `email`, `profile`, `drive.file`. |
| Limited Use affirmation. Google's API-specific policies give the template "The use of information received from ... will adhere to ..., including the Limited Use requirements" (https://developers.google.com/photos/support/api-policy, https://developers.google.com/fit/policy). | PP `#limited-use`: "Silo's use and transfer to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements," linking the policy and the Limited Use anchor. The Indonesian page gives a faithful translation with the same links. |

Google Workspace API User Data and Developer Policy (covers Drive APIs): https://developers.google.com/workspace/workspace-api-user-data-developer-policy

| Requirement | How it is met |
|---|---|
| No "transferring, selling, or using user data to create, train, or improve a machine learning or artificial intelligence model". | PP `#drive-sharing`: never used to train AI or machine learning models, including the email address. |
| Affirmative Limited Use statement in the app or on a website for the app; some disclosures must be inside the app in normal use, not only in a policy. | PP `#limited-use`. Per the new facts, Silo shows an in-app explanation with a Privacy Policy link before connecting (PP `#google-drive` intro). |

Scope classification: `drive.file` is **non-sensitive** (https://developers.google.com/workspace/drive/api/guides/api-specific-auth). `openid`, `email` and `profile` are Google's basic sign-in scopes.

## 2. OAuth consent screen and app verification

Sources: https://support.google.com/cloud/answer/13464321 , https://support.google.com/cloud/answer/13807376 , https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification

| Requirement | How it is met |
|---|---|
| Homepage must identify the app, describe it, not be only a login page, be on a verified domain you own, and not redirect elsewhere. | https://cuang.dev/projects/silo/ does this. **Operator:** verify cuang.dev in Search Console and add it under Authorized domains. |
| Homepage must link to the privacy policy, matching the consent-screen link. | **Operator:** add Privacy and Terms links to the download page (none today). |
| Privacy policy hosted on the homepage's domain. | https://cuang.dev/projects/silo/privacy/ (and `/privacy/id/`). Names the app and developer (PP `#who`). |
| Policy "must disclose how your app accesses, uses, stores, and/or shares Google user data." | PP `#drive-access`, `#drive-use`, `#drive-storage`, `#drive-sharing`, `#drive-revoke`. |
| In-product notices must be prominent and match the policy. | Matches the operator's facts about the Drive explanation screen and report form. |

## 3. Google Play User Data policy and Data safety

Sources: https://support.google.com/googleplay/android-developer/answer/10144311 , https://support.google.com/googleplay/android-developer/answer/10787469

| Requirement | How it is met |
|---|---|
| Developer information and privacy contact. | PP `#who`, `#contact`. |
| Types of data accessed, collected, used and shared, and with whom. | PP `#on-phone`, `#online` (now including Google ML Kit and Play services diagnostics in `#online-google`, and Cloudflare in `#online-site`), `#google-drive`, `#external-ai`, `#reports`, `#permissions`, `#third-parties`. |
| Secure handling. | PP `#security`. |
| Retention and deletion. | PP `#retention`, `#delete`. |
| Labelled as a privacy policy; public non-geofenced URL; not a PDF; names the app or developer. | Yes. |
| Account deletion only applies if accounts exist. | No account. |
| Data safety: "collect" means off-device; SDK data counts as the app's collection. | PP now discloses ML Kit and Play services diagnostic data, which a Data safety form would also need to declare. |

## 4. Indonesia: Personal Data Protection Law (UU PDP, Law No. 27 of 2022)

Official record: https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022 (in force 17 October 2022; transition ended 17 October 2024).
Article texts: https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-21 , .../pasal-30 , .../pasal-32 , .../pasal-40 , .../pasal-41 , .../pasal-44 , .../pasal-45 , .../pasal-46
Summaries: https://fpf.org/blog/indonesias-personal-data-protection-bill-overview-key-takeaways-and-context/ , https://www.dlapiperdataprotection.com/?c=ID&t=law

| Requirement | How it is met |
|---|---|
| Art. 5: information on identity, legal basis, purpose. | PP `#who` (Cuang (formerly CDev) as Pengendali Data Pribadi), `#legal-basis`, `#rights`. |
| Art. 20: six legal bases. | PP `#legal-basis` table. |
| Art. 21(1): when relying on consent, state legality, purpose, type and relevance, retention, details collected, processing period, rights. | `#legal-basis`; `#reports-contents`, `#drive-access`, `#external-ai`; `#retention`, `#reports-keep`; `#rights`. |
| Art. 21(2): notify before the information changes. | PP `#changes`: "Before a change takes effect, we will show it in the app and on this page." |
| Arts. 30, 32, 40, 41: correct, give access, stop processing after withdrawal, and delay or restrict processing, each within 3 x 24 hours. | PP `#rights-how` names all four. PP `#reports-keep` writes "3 x 24 hours (72 hours)" on first use. |
| Art. 44: destroy data at end of retention or on request. Art. 45: tell the data subject when data is deleted or destroyed. | PP `#reports-keep` (12 months after last activity; earlier on request), `#delete` and `#rights-how` ("We tell you when we have deleted data"). |
| Art. 46: written breach notice within 3 x 24 hours to subjects and the authority, with data exposed, when and how, and remediation. | PP `#breach`: "within 3 x 24 hours after we become aware of it". |
| Art. 25: children's data needs parent or guardian consent. | PP `#children`, PP `#reports` (under 18: ask a parent or guardian to send reports), ToS `#age`. |
| Art. 56: cross-border transfer needs equal protection, binding safeguards, or consent. | PP `#transfers`: Discord (USA) relies on standard contractual clauses and the EU-US Data Privacy Framework (Discord's privacy policy, https://discord.com/privacy, confirms DPF participation); Google processes report content outside Indonesia; consent on the report form is the fallback basis. |
| Supervisory authority. | PP `#rights-complain` names the UU PDP authority and Komdigi. |

## 5. GDPR-style rights

Source: Regulation (EU) 2016/679, https://eur-lex.europa.eu/eli/reg/2016/679/oj

| Requirement | How it is met |
|---|---|
| Art. 13(1) and (2): controller and contact, purposes, legal basis, legitimate interests, recipients, transfers, retention, rights, withdrawal, complaint. | PP `#who`, `#legal-basis`, `#third-parties`, `#transfers`, `#retention`, `#rights`. |
| Art. 13(2)(e): whether providing data is required, and what happens if not. | PP `#reports`: sending a report is voluntary; without one you can still use all of Silo. |
| Arts. 15 to 21 and 7(3). | PP `#rights`, `#legal-basis`. |
| Art. 8: children. | PP `#children`. |

## 6. Terms of service

| Point | Source | How it is met |
|---|---|---|
| Standard clauses that shift the business's responsibility are void (Art. 18(1)(a), 18(3)). | Law No. 8 of 1999 on Consumer Protection; https://www.hukumonline.com/klinik/a/klausula-eksonerasi-lt4d0894211ad0e/ | ToS `#liability` is now written as the user's own responsibilities, keeps "except where caused by our intentional act or negligence", and states consumer rights stay in place. No clause shifts our responsibility to the user. |
| Clauses that bind consumers to new rules made unilaterally during use are void (Art. 18(1)(g)). | Same law and source | ToS `#changes`: new terms apply only after the user taps Agree; otherwise the user keeps using their version under the terms already accepted. |
| Consumers may use the Consumer Dispute Settlement Body (BPSK) or the courts (Arts. 45 and 49). | Same law | ToS `#law` names BPSK and Indonesian courts. |
| Agreements with Indonesian citizens must be in Bahasa Indonesia (Art. 31 Law No. 24 of 2009). | https://www.hukumonline.com/berita/a/menkumham-perjanjian-berbahasa-inggris-tetap-sah-lt4b6a1df8b9cbf/ , https://pasal.id/peraturan/putusan-mk/puu-mk-173-2025 | Indonesian versions added. Each English page says the Indonesian version applies if they differ. |
| Third-party terms. | https://policies.google.com/terms , https://openai.com/policies/terms-of-use , https://huggingface.co/terms-of-service | ToS `#third-party`. |

## Revision 2: what changed and why

**New files**
- privacy-id.html and terms-id.html, served at `/privacy/id/` and `/terms/id/`. Same structure and anchors. Each says "Versi bahasa Indonesia ini yang berlaku; versi bahasa Inggris adalah terjemahan." and links the English page. Each English page says "An Indonesian version is available. If they differ, the Indonesian version applies." with a link. Why: UU 24/2009 Art. 31, and so Indonesian users can read the binding text. `hreflang` alternate links were added.

**Styling**
- Added `<meta name="color-scheme" content="dark light">`. In light mode `--primary` is `#0369a1`: measured 5.93:1 on the white cards and 5.67:1 on the page background (`#f8fafc`). The rest of the CSS is still the download page's style block, with the same additions as before.

**Privacy Policy (from the new facts)**
- `#online-google` (section 4d): ML Kit and Google Play services (document scanner, Google Sign-In) may send Google diagnostic data. The page now says "no analytics or tracking of our own" instead of "no analytics". Why: Google's ML Kit data disclosure (https://developers.google.com/ml-kit/android-data-disclosure).
- `#online-site`: cuang.dev goes through Cloudflare; our servers keep no access or error logs. This closes the earlier gap on server log retention.
- `#on-device`: content is processed on the phone "unless you set up an external AI service".
- `#external-ai`: now lists the earlier chat messages, the receipt text, the photo in AI vision mode, the fallback when the on-device model is not ready, and the exact "Settings, AI & Receipt Scanning" steps.
- `#google-drive`: added all requested scopes, email kept and name and photo discarded, the Backups and Receipts folders, the in-app explanation before connecting, the first backup right away, what a backup contains, restore, photos moved by transaction date, and what happens to moved photos after disconnecting. Removed the absolute "never transferred to anyone / no person reads it" wording (review 2 #5). It now says Google data leaves the phone or Drive only when the user sends it. Limited Use template wording kept, with links to the policy and its Limited Use anchor.
- `#reports`: added voluntary sending, the notice above Send, the consent marker, the under-18 rule, Discord in the USA, Google Gemini through Antigravity as a recipient, the hash explained in plain words with its lifetime, deletion 12 months after last activity (including Discord messages, screenshots and logs), and code-history descriptions.
- `#permissions` (new section 8): camera, photos, notifications, run after restart, foreground service, install updates, biometrics, internet, and the unused Firebase Messaging and Install Referrer libraries.
- `#third-parties`: complete recipient list. `#transfers`: Discord's SCC and DPF basis, with consent as the fallback.
- `#retention`: chat kept in memory only, cache, report-related items, code history, and no server logs.
- `#delete`: the wider Erase All Data scope and the backup labels.
- `#rights-how`: Art. 41 restriction within 3 x 24 hours, Art. 45 notice of deletion. `#breach`: counted "after we become aware of it". `#changes`: notice before the change takes effect, and no new use until the user chooses it in the app.
- Plain-language explanations added for hash, scope and user agent. First mention reads "CDev ("we", "us")". jsDelivr link changed to https://www.jsdelivr.com/terms/privacy-policy. App labels now use the app's ", " style, for example "Settings, Data & System".

**Terms**
- `#about`: acceptance is by tapping Agree on first launch. The Privacy Policy is a separate notice, not part of the terms.
- `#licence`: explains "licence", "non-exclusive" and "non-transferable".
- `#warranty`: explains "as is" and "as available".
- `#liability`: rewritten as the user's responsibilities (see section 6 above).
- `#law`: BPSK added. `#changes`: agree-to-apply model (UU 8/1999 Art. 18(1)(g)).
- `#updates`: checksum, package name and version wording now matches the privacy page. "Tell me about new versions" label used.

## Still open for the operator

1. **App labels in Indonesian.** The Indonesian pages show menu labels in English ("Settings, Data & System", "Erase All Data" and others) because the Indonesian UI strings were not provided. If the app has an Indonesian UI, swap in its exact labels.
2. **Report form.** It mentions the developer's server and Discord in the USA. The policy says Google processes reports when an issue is fixed, and treats consent on the form as the fallback transfer basis. Consider naming Google AI processing on the form too, so that consent covers it.
3. **Emails to silo@cuang.dev** are kept "as long as needed". There is no fixed period.
4. **Download page.** It still says "No account and no cloud" and has no Privacy or Terms links.
5. **Indonesian supervisory authority.** Confirm whether the UU PDP agency is now operating, and its name.
6. **Commitments the operator must keep.** Replies within 3 x 24 hours, breach notice within 3 x 24 hours, notice in the app before policy changes, and no new data use without an in-app choice.
7. **Legal review.** These texts were not reviewed by an Indonesian lawyer. A short legal review is recommended before Google OAuth verification.
