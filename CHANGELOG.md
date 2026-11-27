# Changelog

User-visible changes to Silo, newest first. Format: [Keep a Changelog](https://keepachangelog.com). Releases are
published at https://cuang.dev/projects/silo/ (tags `vX.Y.Z`, branch `prod` = latest release).

## [Unreleased]

## [1.3.12] - 2026-11-27
### Changed
- Silo's Android package id is now `dev.cuang.silo` (was `com.LCSdev.silo`). Android treats it as a new app: 1.3.11
  can't update to it in place, so back up, install 1.3.12 from the download page, restore, then uninstall the old one.
- The developer name is now Cuang (was CDev) in the app, the Privacy Policy and the Terms. The Terms version changed,
  so Silo asks you to agree again once.

## [1.3.11] - 2026-11-26
### Changed
- AI model downloads keep going with Silo in the background or closed, with a progress bar in the notification
  (Pause / Cancel, and Resume / Cancel when paused). An interrupted download continues from where it stopped
  instead of starting over, waits for the connection (or Wi-Fi) to come back, and is checked against the model's
  SHA-256 before it is installed. Silo asks for notification permission the first time a download starts.

## [1.3.10] - 2026-11-26
### Fixed
- Receipt items are read when an item's name and price are on different lines (name, then "13,000 X 1  13,000",
  "4x @35.000  140.000" or "@38.000  38.000"), with option lines ("+Less Sugar", "NORMAL ICE 1x @0") kept as notes
  and discounts taken off the item above them. Before, Silo listed payment, TOTAL PAID, tax, date and address lines
  as items. On a 190-receipt benchmark, receipts read with exactly the right items went from 29% to 75%.
- When the on-phone AI also reads the receipt, Silo keeps the OCR items unless only the AI's add up to the total.

## [1.3.9] - 2026-11-25
### Added
- 37 more currencies (57 in all), including CAD, MOP, KHR, BRL, MXN, ZAR, SEK, PLN and TRY, each with its symbol.
  A "More…" button opens a searchable list wherever you pick a currency: home currency (Settings and first
  launch), accounts and budgets. Settings and first launch used to offer only IDR, USD, EUR, GBP, SGD and JPY;
  TWD is now one of the quick choices.
### Changed
- TWD (and KHR, LAK, MMK, CLP, COP, ISK, HUF) amounts are written without decimals, like everyday prices
  (NT$ 1.200, not NT$ 1.200,00).

## [1.3.8] - 2026-11-25
### Added
- Split Bill: Remove split on the expense page (trash button next to Split) and on the split page; saving a split
  with everyone taken off offers the same. The expense stays; if repayments were logged as income, Silo asks
  whether to delete that income too (the All Splits trash button asks the same now).

## [1.3.7] - 2026-11-25
### Changed
- Silo AI has one mode: the Grounded / Chat toggle is gone. Both modes read your records and needed the same
  model; Silo AI now answers from your records and gives advice in the same chat.
- Silo AI answers planning questions with numbers worked out from your records: "How can I save 20% of my
  income?", "If I cut food in half...", "How long to save 10 million?", "How many months could my savings
  cover?", "Make me a budget for next month".
### Fixed
- Silo AI no longer refuses advice ("I don't have that in my Silo records" for "any tips?").
- When Silo AI's answer contains a number that isn't in your records, it tries once more before showing the plain
  facts; the plain facts now start with a short note instead of a raw list.
- "Can I still ... without going over my budget?" answers No when that budget is already over.

## [1.3.6] - 2026-11-25
### Fixed
- Silo AI: "What is my most spent category" (and "most spending", "where is my money going") now gets your real
  top categories; before, the offline model got no category facts and repeated your balance or made up a list.
- Silo AI no longer repeats its earlier answers: each question gets fresh facts, and short follow-ups like
  "And last month?" or "What category was that?" keep the earlier topic.
- Silo AI never shows amounts that are not in your records; such a reply is replaced by the facts themselves.
- Silo AI reads over-budget categories correctly: it used to call "over by Rp 41.000" money left, and to say
  "not over budget" when one budget was over but all budgets together were not.
### Changed
- Silo AI answers more questions from your records: this month vs last month, "Compare October and November",
  which store you spent most at, average per day, coffee or subscriptions across merchants, "Bali trip".
### Added
- Chat benchmark for the offline AI (50 questions over 3 months of sample data); see bench/chat/README.md.

## [1.3.5] - 2026-11-25
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
