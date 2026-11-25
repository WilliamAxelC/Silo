# Chat benchmark: final-0.8B-v2

153 answers (3 per case). "Raw" is the model's text; "shown" is after the app's reply guard.

| Tier | Raw pass | Shown pass | Raw invented amounts | Shown invented amounts |
|---|---|---|---|---|
| typical | 54/54 (100.0%) | 54/54 (100.0%) | 0 | 0 |
| hard | 35/36 (97.2%) | 36/36 (100.0%) | 1 | 0 |
| abstract | 14/21 (66.7%) | 17/21 (81.0%) | 3 | 0 |
| followup | 11/12 (91.7%) | 11/12 (91.7%) | 0 | 0 |
| indonesian | 12/18 (66.7%) | 18/18 (100.0%) | 3 | 0 |
| offtopic | 12/12 (100.0%) | 12/12 (100.0%) | 0 | 0 |
| **overall** | 138/153 (90.2%) | 148/153 (96.7%) | 7 | 0 |

Median latency 1.11s on the bench host.

## Failures (shown answer)

- **where-money-goes#0** {"facts":false,"forbid":true,"grounded":true}: Your money is currently in your Silo app on this phone.
- **phone-regret#0** {"facts":false,"forbid":true,"grounded":true}: No, buying the new phone was not a bad idea because it is the only item you can buy in your Silo records right now.
- **phone-regret#2** {"facts":false,"forbid":true,"grounded":true}: No, buying the new Samsung Galaxy A55 is not a bad idea, as it was the only transaction in your Silo record for November 2026.
- **month-summary#0** {"facts":false,"forbid":true,"grounded":true}: This month, you saved Rp 1.970.500 (Net +Rp 1.970.500) and spent Rp 13.279.500. Your spending was split between shopping Rp 5.201.000, bills Rp 3.934.000, and food & dining Rp 1.549.000.
- **followup-which-category#2** {"facts":false,"forbid":true,"grounded":true}: Erafone Rp 4.899.000 was the biggest expense this month.
