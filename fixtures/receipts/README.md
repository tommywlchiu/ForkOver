# Receipt eval fixtures

This folder holds the real receipt photos and the hand-written answers for the model eval
(`SPEC.md` section 7.7). The eval reads each photo with each model, compares the result to your
answer, and prints a comparison table you use to set the accuracy target and pick the model.

## Real licensed set

12 real receipt photos from Wikimedia Commons and Flickr, under CC0, CC BY, or CC BY-SA, are
committed here. `ATTRIBUTION.md` lists each file's author, license, source, and changes (all are
resized, and card digits are covered on two). Their `.expected.json` files carry a `notes` field
saying so; the answers are drafts until a human has checked them against the photos.

Between them they cover `long`, `crumpled`, `auto-gratuity`, `surcharge`, `quantity-line`, and
`non-usd` (three JPY, plus EUR, GBP, and HKD). **No licensed photo covers `handwritten-tip` or
`discount`; those still need the captain's own photos** before the real set meets SPEC 7.7.

Tax-inclusive receipts (JPY, EUR, GBP) record `taxCents: 0`, since the printed tax is already in
the item prices and adding it would overshoot the total. The `notes` say what the receipt prints.

## Local-only fixtures

Photos that must not be public (unclear license, card or personal details) go in
`fixtures/receipts-local/`, which is git-ignored. Give each one an `.expected.json` the same way,
then run the eval against that folder:

```sh
npm run eval:receipts -- --dir fixtures/receipts-local --stub
```

## Synthetic set (preliminary only)

The 10 `*-synthetic.jpg`-style fixtures currently in this folder (`sunny-side-diner-long.jpg`
through `pinewood-family-diner-long.jpg`) are computer-rendered, not photos: monospace text drawn
onto a plain background, with a few given a rotation, blur, or a simulated fold/crease/shadow so
the set isn't uniformly pristine. Every one has fake merchant names and items, and its
`.expected.json` carries a `notes` field saying so. They cover the `kinds` this README requires at
least once each, but there are 10 of them, short of the 12 SPEC 7.7 asks for.

They exist only so an early, clearly-labeled-synthetic comparison of `claude-haiku-4-5-20251001`
and `claude-sonnet-5` can run before real photos are available. A rendered receipt has none of the
noise a phone photo does — no real paper texture, no printer wear, no actual handwriting, no
lighting or focus variation beyond the simple filters applied here — so its accuracy numbers
overstate how the models will do on the photos a payer actually takes. **The captain's real receipt
photos are what decide the model and the accuracy target at the M2 checkpoint (SPEC.md section
11)**; this synthetic set does not substitute for them. Delete or keep these fixtures once real
photos land, at the captain's discretion.

## What to add

Your own photos, at least for the missing kinds. The set needs at least **12 real receipt photos**, taken the way a payer would take them. Between them they must cover:

| Kind (`kinds` tag) | What to look for |
|---|---|
| `long` | A long receipt, many lines, the kind that needs scrolling |
| `crumpled` | Creased or crumpled paper |
| `handwritten-tip` | A tip and total written in by hand |
| `auto-gratuity` | An automatic gratuity printed on the receipt (large-party charge) |
| `discount` | A discount, coupon, or comp (a negative line) |
| `surcharge` | A surcharge or service fee that is not a tip |
| `quantity-line` | A line like `2 Beer 17.00` |
| `non-usd` | Not US dollars, JPY if you can |

One photo can carry several tags. Mixed sizes, lighting, and angles make the eval more honest.
The eval prints a note if you have fewer than 12 fixtures or a kind is untagged.

Size the photos like the app does (`SPEC.md` 7.6): long edge at most 1568 px, JPEG around 0.85. The eval sends
the file as is, so a full-size phone photo costs more tokens than the app would spend, and a file over
`MAX_IMAGE_BYTES` (default 5,000,000 bytes) fails with `TOO_LARGE`.

## File layout

Each photo needs an answer file with the same name, ending in `.expected.json`:

```
fixtures/receipts/
  izakaya-friday.jpg            # .jpg, .jpeg, or .png
  izakaya-friday.expected.json
  ramen-tokyo.png
  ramen-tokyo.expected.json
```

The eval stops before calling the API if a photo has no answer file, an answer file has no photo, or an answer file is invalid.
Do not commit receipts you would not want public: they contain merchant names, and sometimes card digits or names.
Crop or cover anything personal.

## Writing an expected file

It uses the same fields as the parser's output (`ParsedReceipt` in `src/lib/receipt/schema.ts`), so you can
compare them line by line. **All amounts are integers in the currency's minor units**: cents for USD, whole yen for JPY.
`$17.00` is `1700`; `¥1,800` is `1800`. Type what the receipt says, not what the model should have said.

| Field | Write |
|---|---|
| `currency` | ISO 4217 code, for example `"USD"` or `"JPY"` |
| `items` | One entry per printed line: `name`, `quantity`, and `lineTotalCents` for the **whole line**. `2 Beer 17.00` is quantity 2, `1700`. Fold priced modifiers into the parent line. Leave out zero-price modifiers and voided lines. |
| `discountCents` | Sum of all discounts, coupons, and comps, as a **positive** number. `0` if none. |
| `taxCents` | Sum of tax lines added on top of the item prices. `0` if none, or if tax is included in the prices. |
| `fees` | Surcharges and other non-tip fees: `{ "label": "...", "cents": 0 }`. `[]` if none. |
| `printedTipCents` | Automatic gratuity plus any printed or handwritten tip. `null` if the receipt shows none. |
| `printedSubtotalCents` | The subtotal printed on the receipt, or `null` if it prints none. |
| `printedTotalCents` | The final total (the handwritten total if there is one), or `null`. |

Two optional fields are for you and the report: `kinds` (an array of the tags above) and `notes`.
Unknown keys are rejected, so a typo cannot silently go unscored.

### Worked example (fake data)

`fake-diner.jpg` is a photo of a receipt for a made-up diner, with a beer line for two, a fee, a discount, and a handwritten tip:

```
FAKE DINER
2 Draft Beer        17.00
1 Katsu Curry       18.95
Coupon             -5.00
Subtotal            30.95    <- printed
Tax                  3.00
Service charge       2.00
Tip (handwritten)    4.00
TOTAL               39.95    <- handwritten
```

`fake-diner.expected.json`:

```json
{
  "currency": "USD",
  "items": [
    { "name": "Draft Beer", "quantity": 2, "lineTotalCents": 1700 },
    { "name": "Katsu Curry", "quantity": 1, "lineTotalCents": 1895 }
  ],
  "discountCents": 500,
  "taxCents": 300,
  "fees": [{ "label": "Service charge", "cents": 200 }],
  "printedTipCents": 400,
  "printedSubtotalCents": 3095,
  "printedTotalCents": 3995,
  "kinds": ["quantity-line", "discount", "surcharge", "handwritten-tip"],
  "notes": "Made-up example. Delete me."
}
```

Do not copy this into the folder: it has no photo, and the eval would report it as a fixture without one.

## How answers are scored

For each receipt and model:

- **Every item and price**: each expected item pairs with one returned item having the same name, quantity, and
  line total, in any order. Names ignore case, punctuation, and spacing. Missing or extra items fail this check.
- **Item count**: the number of items is the same.
- **Subtotal, Total**: equal to the printed figures (`null` must match `null`).
- **Tax, Discount**: equal.
- **Tip**: equal, where no tip and `0` count as the same.
- **Fees**: the fee amounts add up to the same sum (labels are not compared).
- **Currency**: same ISO code.
- **Everything right**: all of the above.

A scan that fails (an upstream or output error) counts as failing every check.
The report also gives time to first item and time to done (median and 90th percentile), input and output tokens, and cost per scan,
for each receipt and for each model, then a side-by-side comparison.

## Run it

Live, with both models (`claude-haiku-4-5-20251001` and `claude-sonnet-5`); this spends real API money, a fraction of a cent to a couple of cents a scan:

```sh
ANTHROPIC_API_KEY=<your key> npm run eval:receipts
```

Options go after `--`:

```sh
npm run eval:receipts -- claude-sonnet-5              # only the models you name
npm run eval:receipts -- --json eval-results.json     # also write raw per-scan results
npm run eval:receipts -- --dir some/other/folder      # a different fixtures folder
```

Try the whole pipeline first with no key and no spend. Stub mode answers from a fake upstream that echoes your expected files
(or two built-in cases if the folder is empty), so its accuracy numbers mean nothing:

```sh
npm run eval:receipts -- --stub
```

**Cost figures are only as current as** `src/lib/receipt/eval/pricing.ts`, which holds the per-million-token prices with their source URL and the date they were taken.
Update that file when Anthropic's prices change or you eval another model.

Rerun the eval on every prompt or model change before it ships (`SPEC.md` 7.7).
