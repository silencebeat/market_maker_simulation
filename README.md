# Tokocrypto Orderbook Simulator (Pairing token/IDR)

Simulator ini menampilkan orderbook dan menghitung Unrealized PnL secara real-time untuk pasangan **token/IDR**.  
Contoh: `BTC/IDR`, `TRUMP/IDR`, `AI/IDR`.

Backend mengirim data orderbook via WebSocket (`ws://localhost:3000`), dan front-end menampilkannya lengkap dengan depth chart langsung di tabel.

---

## Fokus: Pairing token/IDR

- **Base Coin** = token yang diperdagangkan (misal `BTC`, `AI`, `TRUMP`)
- **Quote Coin** = IDR (Rupiah)
- Semua harga dalam IDR, semua quantity dalam token.

---

## Penentuan Harga token/IDR

Harga pairing token/IDR dihitung secara **real-time** dengan metode berikut:

1. **Ambil harga token/USDT dari Binance**  
   - Contoh: `TRUMP/USDT` di Binance = `8.88 USDT`

2. **Ambil harga USDT/IDR dari Tokocrypto**  
   - Contoh: `USDT/IDR` di Tokocrypto = `16,300 IDR`

3. **Konversi ke token/IDR**  
   - token/IDR = (token/USDT) × (USDT/IDR)

**Contoh:**

Metode ini memastikan harga token/IDR selalu mengikuti pasar global (Binance) dan kurs lokal (Tokocrypto).

---

## Populate Orderbook

### 1. Sumber Data
Data pairing token/IDR diterima dari backend dengan format:
```json
{
"bids": [{ "price": 144000, "qty": 0.5 }, { "price": 143995, "qty": 1.2 }],
"asks": [{ "price": 144500, "qty": 0.4 }, { "price": 144505, "qty": 1.0 }],
"midPrice": 144250,
"baseCoin": "TRUMP",
"quoteCoin": "IDR"
}
```

### 2. Menentukan Harga Per Level
Bid Side (pembeli):

Mulai dari harga bid tertinggi (best bid), turun dengan kelipatan tick size.

Tick size IDR biasanya 1, 5, atau 10.

Contoh: best bid = 144,000, tick size = 5 →
144,000 → 143,995 → 143,990

Ask Side (penjual):

Mulai dari harga ask terendah (best ask), naik dengan kelipatan tick size.

Contoh: best ask = 144,500, tick size = 5 →
144,500 → 144,505 → 144,510

### 3. Quantity Per Level
Ambil langsung dari data pasar backend.

Jika disimulasikan, gunakan nilai acak realistis:

const qty = parseFloat((Math.random() * maxQty).toFixed(6));

## Perhitungan Unrealized PnL
Rumus per transaksi:
BUY  → (midPrice - hargaBeli) * qty
SELL → (hargaJual - midPrice) * qty

Contoh:
Transaksi: BUY 0.045395 TRUMP @ 144,455 IDR
Mid Price: 145,000 IDR
PnL = (145,000 - 144,455) * 0.045395 = 24.77 IDR

Total Unrealized PnL = jumlah seluruh PnL.

## Menjalankan
1. Jalankan backend yang mengirim orderbook dan mid price token/IDR di ws://localhost:3000.

2. Backend harus:

        - Mengambil harga token/USDT dari Binance.

        - Mengambil harga USDT/IDR dari Tokocrypto.

        - Menghitung harga token/IDR dari hasil perkalian keduanya.

3. Buka index.html di browser.

4. Gunakan tombol:

        - Simulate MARKET BUY → membuat transaksi beli acak.

        - Simulate MARKET SELL → membuat transaksi jual acak.

5. Lihat:

        - Orderbook → harga & qty per level + depth chart.

        - Unrealized PnL → total PnL posisi terbuka.

        - Transaction Log → riwayat transaksi dan PnL masing-masing.