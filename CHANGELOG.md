# Changelog

User-visible changes to Silo, newest first. Format: [Keep a Changelog](https://keepachangelog.com). Releases are
published at https://cuang.dev/projects/silo/ (tags `vX.Y.Z`, branch `prod` = latest release).

## [Unreleased]
### Changed
- Split Bill: each expense's split page now shows who owes what, with Mark paid, WhatsApp and Share on each
  person; the setup folds away after saving (Edit split to change it). All Splits stays in More.
- Split expenses carry a badge in Cashflow: amber while someone still owes, green once everyone has paid.

## [1.3.4] - 2026-11-24
### Added
- Split Bill: split an expense equally, by amounts or by items (shared items and tax prorated), send each person
  what they owe on WhatsApp or any app, and mark who has paid (optionally logging the repayment as income).
- Contacts for Split Bill: add people by hand or import selected contacts from the phone (read only).
- AI accuracy notice before the first chat, and a short reminder under the chat box.
### Changed
- Chat mode now answers from your own records (top categories, totals, budgets), not just general tips.
- Privacy Policy covers Split Bill: contacts, sharing to WhatsApp, the contacts permission.
### Fixed
- Reports: the Expenses/Income toggle was squeezed ("Expense/s"); it now fills its row with arrow icons.

## [1.3.3] - 2026-11-24
### Added
- In-app updates: Silo downloads a new version, checks its checksum and hands it to Android to install.
- Google Drive sync (optional): daily backup to a Silo folder in your Drive (newest 30 kept), restore from Drive,
  and moving receipt photos older than 3, 6 or 12 months to Drive.
- Terms of Service and Privacy Policy (English and Indonesian), with an Agree step on first launch.
- Hidden test channel for early builds (tap Version 7 times).
### Changed
- Signed with Silo's own private key (was the public React Native debug key). One-time reinstall from 1.3.2.
- Report form says exactly where reports go; each report records the consent text shown.
### Security
- Restoring a backup can no longer change this phone's AI server, AI mode, app lock or Drive connection.
- Shared images: only real images from other apps are accepted; deep links cannot make Silo read a file.
- Reports are deleted 12 months after their last activity; no IP-address logs on cuang.dev for Silo.

## [1.3.2] - 2026-11-23
### Added
- Report a bug / Request a feature from More (goes to the developer; nothing about your money is sent).
- Savings goals, by hand or following an account, with the monthly amount needed.
- Automatic daily backups on the phone (last 7), Erase all data, and a Privacy page in the app.
- On-phone error log (numbers masked) that can be attached to a report.
### Changed
- Accessibility: 48dp touch targets, screen readers can reach controls inside sheets, WCAG AA contrast.
### Fixed
- Restoring a backup dropped tags, tagged transactions and budget plans.
- "Back up now" did nothing after automatic backups had been switched off once.

## [1.3.1] - 2026-11-23
### Added
- New-version notice (banner and More, App info) and an App info section.
- The AI model download is offered on first launch.
- One Filters button and a collapsible search on Cashflow and Reports.
### Fixed
- Tapping Amount did nothing unless Merchant was tapped first.
- Chat claimed a "network error" for vague questions.
### Security
- First fixes for backup restore and shared photos.

## [1.3.0] - 2026-11-23
### Added
- Share receipts to Silo from any app (one photo or many).
- Sideways receipts are turned upright before reading.
### Changed
- The AI model is freed shortly after Silo goes to the background, so the phone wakes faster.

## [1.2.0] - 2026-11-22
### Added
- Activity log with undo, receipt scans in the background, Reports grouped by category, account or tag.
- Confirmation for receipt dates far from today.

## [1.1.0] - 2026-11-22
### Added
- Accounts in other currencies with exchange rates, tags, and budgets for any period (including holidays).

## [1.0.2] - 2026-11-22
- First public test build.
