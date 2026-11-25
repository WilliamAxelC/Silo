# Chat benchmark: baseline-0.8B

150 answers (3 per case). "Raw" is the model's text; "shown" is after the app's reply guard.

| Tier | Raw pass | Shown pass | Raw invented amounts | Shown invented amounts |
|---|---|---|---|---|
| typical | 48/54 (88.9%) | 48/54 (88.9%) | 6 | 6 |
| hard | 15/36 (41.7%) | 15/36 (41.7%) | 6 | 6 |
| abstract | 13/21 (61.9%) | 13/21 (61.9%) | 5 | 5 |
| followup | 5/12 (41.7%) | 5/12 (41.7%) | 3 | 3 |
| indonesian | 12/15 (80.0%) | 12/15 (80.0%) | 3 | 3 |
| offtopic | 7/12 (58.3%) | 7/12 (58.3%) | 2 | 2 |
| **overall** | 100/150 (66.7%) | 100/150 (66.7%) | 25 | 25 |

Median latency 2.30s on the bench host.

## Failures (shown answer)

- **top-category#0** {"facts":false,"forbid":true,"grounded":false}: 1. Food & Dining: Rp 5.100.000 2. Transportation: Rp 3.200.000 3. Utilities & Bills: Rp 1.200.000 4. Entertainment: Rp 1.000.000 5. Personal Care & Clothing: Rp 500.000 6. Other: Rp 1.000.000
- **top-category#1** {"facts":false,"forbid":true,"grounded":false}: 1. Food & Dining: Rp 11.279.500 (46 txns) 2. Utilities: Rp 1.970.500 (46 txns) 3. Transport: Rp 1.970.500 (46 txns) 4. Entertainment: Rp 1.970.500 (46 txns) 5. Insurance: Rp 1.970.500 (46 txns) 6. Education: Rp 1.970.500 (46 txns) 7. Health
- **top-category#2** {"facts":false,"forbid":true,"grounded":false}: 1. Food: Rp 1.327.950 2. Utilities: Rp 1.250.000 3. Transport: Rp 1.000.000 4. Education: Rp 750.000 5. Entertainment: Rp 500.000 6. Housing: Rp 250.000 7. Medical: Rp 100.000 8. Travel: Rp 50.000 9. Insurance: Rp 20.000 10. Other: Rp 10.00
- **biggest-expense#1** {"facts":true,"forbid":true,"grounded":false}: 1. Erafone Rp 4,899,000 was the biggest expense this month. 2. This month's total spending was Rp 10,000,000. 3. You can save money by using the Erafone app to track your spending.
- **food-budget-left#1** {"facts":false,"forbid":true,"grounded":false}: 1.549.000 Rp remains in your food budget. 2.500.000 Rp is the total limit for this month. 3.951.000 Rp is the remaining amount after spending Rp 1.549.000.
- **over-budget#1** {"facts":true,"forbid":true,"grounded":false}: Yes, you are over budget on several categories. Your total monthly limit is Rp 4.100.000, but you have already spent Rp 7.391.000, which means you are over by Rp 3.291.000. Here is the breakdown by category: * **Food & Dining:** You are ove
- **compare-months#0** {"facts":false,"forbid":true,"grounded":true}: Yes, you spent more this month than last month. You spent Rp 12.503.500 this month compared to Rp 12.500.000 last month. This means you saved Rp 3.500 (52 transactions) this month.
- **compare-months#1** {"facts":false,"forbid":true,"grounded":true}: Yes, you spent more this month than last month. Your records show you spent Rp 12,503,500 last month, while this month you spent Rp 12,500,000. This means you saved Rp 3,500 last month.
- **compare-months#2** {"facts":false,"forbid":true,"grounded":true}: Yes, you spent more this month than last month. Your record shows you spent Rp 12.503.500 last month, while this month you spent Rp 12.500.000. This means you saved Rp 3.500 this month.
- **top-merchant#0** {"facts":false,"forbid":true,"grounded":false}: 1. **Silo Records** - Total spent: $0 - No transactions found in this month. 2. **Amazon** - Total spent: $0 - No transactions found in this month. 3. **Apple** - Total spent: $0 - No transactions found in this month. 4. **Microsoft** - Tot
- **top-merchant#1** {"facts":false,"forbid":true,"grounded":false}: 1. **Amazon** - **Amount Spent:** $2,340.00 - **Reason:** This is the highest value transaction in your Silo records for this month. 2. **Target** - **Amount Spent:** $1,200.00 - **Reason:** This is the second highest value transaction in y
- **top-merchant#2** {"facts":false,"forbid":true,"grounded":false}: 1. **Grocery Store** - **Total Spent:** $1,240.00 - **Breakdown:** - **Milk:** $240.00 - **Bread:** $150.00 - **Cheese:** $100.00 - **Pasta:** $100.00 - **Soda:** $50.00 - **Other:** $50.00 2. **Department Store** - **Total Spent:** $450.00
- **gofood-count#0** {"facts":false,"forbid":true,"grounded":true}: 1. You have no matching transactions for GoFood in this month.
- **gofood-count#1** {"facts":false,"forbid":true,"grounded":true}: 1. You have not ordered GoFood this month.
- **coffee#0** {"facts":false,"forbid":true,"grounded":true}: You spent Rp 101,500 on coffee this month. This total comes from two transactions: Fore Coffee on November 11th for Rp 59,000 and another one on May 11th for Rp 42,500.
- **coffee#1** {"facts":false,"forbid":true,"grounded":true}: You spent Rp 101,500 on coffee this month, consisting of Rp 59,000 from 11/11 Fore Coffee and Rp 42,500 from 05/11 Fore Coffee. **Note:** I am running on this phone, so please keep it safe and secure.
- **coffee#2** {"facts":false,"forbid":true,"grounded":true}: You spent Rp 101,500 on coffee this month. This includes Rp 59,000 from the 11/11 Fore Coffee transaction and Rp 42,500 from the 05/11 Fore Coffee transaction.
- **avg-daily#0** {"facts":false,"forbid":true,"grounded":false}: 1. No matching transactions found in this month. 2. This month's total balance is $0. 3. Therefore, your average daily spending is $0.
- **avg-daily#1** {"facts":false,"forbid":true,"grounded":true}: 1. No matching transactions found in this month. 2. Your Silo records show no data for daily spending. 3. You can't calculate an average without a list of transactions. 4. To find your average, please share your transaction list. 5. If you 
- **avg-daily#2** {"facts":false,"forbid":true,"grounded":false}: 1. No matching transactions found in this month. 2. Your average daily spending is currently zero. 3. This month's spending total is $0. 4. You have no money to spend. 5. You are currently in a state of financial stagnation.
- **bali-trip#0** {"facts":false,"forbid":true,"grounded":true}: I don't have access to your personal financial records or specific transaction history on this phone. I can tell you about your Bali trip if you tell me where you went!
- **bali-trip#1** {"facts":false,"forbid":true,"grounded":true}: I don't have access to your personal financial records, so I can't give you the exact total cost of your Bali trip. If you want to know how much you spent, please check your bank statements or your Silo records for a matching transaction la
- **bali-trip#2** {"facts":false,"forbid":true,"grounded":true}: I don't have access to your personal financial history or specific transaction records. I can only provide general advice on how to plan a trip, but I cannot calculate the exact cost or verify your current balance.
- **subscriptions#0** {"facts":false,"forbid":true,"grounded":false}: 1. No subscriptions were found in your records. 2. You are currently on a free trial for the new AI tools. 3. You can upgrade your plan for Rp 500,000 if you want to access premium features. 4. Your current plan covers all features at Rp 15
- **subscriptions#1** {"facts":false,"forbid":true,"grounded":true}: 1. No subscriptions are currently being paid for. 2. Your monthly budget allows for a full subscription-free experience. 3. You have no pending subscriptions to cancel or renew.
- **subscriptions#2** {"facts":false,"forbid":true,"grounded":true}: 1. No matching subscriptions found in your records. 2. You are paying for your own purchases (shopping, bills, food). 3. Your net monthly income is Rp 1.970.500, which covers your expenses.
- **transport-budget-left#0** {"facts":false,"forbid":true,"grounded":true}: Yes, you can still take Grab rides this month without exceeding your transport budget. Your current limit is Rp 600.000, and you have already spent Rp 641.000, leaving you with a surplus of Rp 41.000. Since there are no matching transaction
- **doing-okay#2** {"facts":true,"forbid":true,"grounded":false}: Yes, you are doing okay financially, as your net income of Rp 1.970.500 is positive, meaning you have more money than you spent in this month. To improve your financial situation, consider saving Rp 500.000 per month for a rainy day and pay
- **where-money-goes#0** {"facts":false,"forbid":true,"grounded":true}: 1. Your Main Wallet (Rp 1.074.500) is currently sitting at home. 2. Your Bank account (Rp 8.661.000) is likely at your local branch. 3. Your GoPay account (Rp 861.500) is likely at your local branch. *Note: This assumes you are currently at
- **where-money-goes#1** {"facts":false,"forbid":true,"grounded":true}: 1. Your Main Wallet is currently at Rp 1,074,500. 2. Your Bank account holds Rp 8,661,000. 3. Your GoPay account holds Rp 861,500. Please check your phone for the specific transaction details you need.
- **where-money-goes#2** {"facts":false,"forbid":true,"grounded":true}: 1. Your main wallet (Rp 1.074.500) is currently in your physical wallet. 2. Your bank account (Rp 8.661.000) is in your physical wallet. 3. Your GoPay balance (Rp 861.500) is in your physical wallet.
- **afford-laptop#1** {"facts":true,"forbid":true,"grounded":false}: Based on your records, you have **Rp 1.970.500** in net income, which is insufficient to buy a 5 million laptop. You currently have **Rp 13.279.500** in total spending, which means you have **Rp 8.309.000** left over. To afford a 5 million 
- **afford-laptop#2** {"facts":false,"forbid":true,"grounded":false}: Based on your current monthly spending, you will likely not be able to afford a 5 million laptop next month. Your total monthly expenses are around Rp 13.28 million, which is significantly lower than the Rp 5 million needed for a laptop. To
- **month-summary#1** {"facts":true,"forbid":true,"grounded":false}: Here is the summary of your month: * **Total Spent:** Rp 13.279.500 * **Total Income:** Rp 15.250.000 * **Net Result:** +Rp 1.970.500 (46 transactions) * **Top Categories:** Shopping (Rp 5.201.000), Bills (Rp 3.934.000), Food & Dining (Rp 1
- **month-summary#2** {"facts":true,"forbid":true,"grounded":false}: Here is the monthly summary from your Silo records: * **Income:** Rp 15,250,000 * **Spending:** Rp 13,279,500 * **Net Result:** +Rp 1,970,500 (46 transactions) * **Top Categories:** Shopping (Rp 5.2M), Bills (Rp 3.9M), Food & Dining (Rp 1.5
- **followup-after-balance#0** {"facts":false,"forbid":true,"grounded":false}: 1. Food & Dining: Rp 3.100.000 2. Utilities: Rp 2.000.000 3. Transport: Rp 1.500.000 4. Education: Rp 1.200.000 5. Health & Beauty: Rp 800.000 6. Entertainment: Rp 500.000 7. Other: Rp 1.000.000
- **followup-after-balance#1** {"facts":false,"forbid":true,"grounded":false}: 1. Food & Dining: Rp 6.500.000 2. Transportation: Rp 4.200.000 3. Utilities: Rp 2.100.000 4. Housing: Rp 1.500.000 5. Healthcare: Rp 800.000
- **followup-after-balance#2** {"facts":false,"forbid":true,"grounded":false}: 1. Food and Dining: Rp 3.279.500 2. Transportation: Rp 2.170.000 3. Utilities: Rp 1.170.000 4. Entertainment: Rp 1.000.000 5. Other: Rp 1.000.000
- **followup-bad-history#1** {"facts":true,"forbid":false,"grounded":true}: 1. Food & Dining: Rp 10.597.000 2. Transportation: Rp 10.597.000 3. Entertainment: Rp 10.597.000 4. Utilities: Rp 10.597.000 5. Shopping: Rp 10.597.000
- **followup-bad-history#2** {"facts":false,"forbid":false,"grounded":true}: 1. Food: Rp 10.597.000 2. Transportation: Rp 10.597.000
- **followup-which-category#0** {"facts":false,"forbid":true,"grounded":true}: Erafone was a major category, spending Rp 4.899.000 on 20 Nov.
- **followup-which-category#1** {"facts":false,"forbid":true,"grounded":true}: Erafone was spent on 20 Nov, which falls under the **Bills** category. Your biggest expense this month was Erafone, Rp 4.899.000, on 20 Nov.
- **id-sisa-transport#0** {"facts":false,"forbid":true,"grounded":false}: Sisa anggaran transport Rp 600.000.000 (Rp 600.000) setelah Rp 641.000.000 ditambahkan.
- **id-sisa-transport#1** {"facts":false,"forbid":true,"grounded":false}: Sisa anggaran transport Rp 600.000.000.
- **id-sisa-transport#2** {"facts":false,"forbid":true,"grounded":false}: Sisa anggaran transport Rp 600.000.000.000 (Rp 600.000.000) dan total yang ditransfer Rp 641.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.000.00
- **weather#1** {"facts":true,"forbid":true,"grounded":true,"noData":false}: Jakarta is currently experiencing a warm and humid day with frequent thunderstorms.
- **weather#2** {"facts":true,"forbid":true,"grounded":true,"noData":false}: Jakarta is currently known as the "City of the Sun" and is known for its tropical climate, which is perfect for enjoying the heat.
- **spotify#0** {"facts":true,"forbid":true,"grounded":false,"noData":false}: 1. Spotify is a subscription service where you pay a monthly fee to access unlimited music and audio content. 2. The cost depends on your plan tier (e.g., Basic, Premium, or Pro) and your location, as prices vary by region. 3. You can cance
- **spotify#1** {"facts":true,"forbid":true,"grounded":true,"noData":false}: 1. Spotify is a subscription service where you pay a monthly fee to access unlimited audio content. 2. The exact amount depends on your chosen tier (Basic, Standard, Premium, or Ultimate) and your location. 3. You can cancel your subscripti
- **spotify#2** {"facts":true,"forbid":true,"grounded":false,"noData":false}: 1. Spotify requires a subscription fee of $14.99 per month. 2. You can cancel your subscription anytime via the Spotify app or website. 3. This monthly fee covers all premium features like ad-free listening and unlimited downloads.
