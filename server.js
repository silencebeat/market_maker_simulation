const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');
require('dotenv').config()

// CONFIG
const PORT = process.env.PORT || 3000;
const START_BASE = 1000000; // initial BASE
const START_IDR = 10000000; // initial IDR
const LEVELS = 10; // number of levels per side
const SPREAD_PCT = 0.001; // 0.1% total spread (0.001 = 0.1%)
const UPDATE_INTERVAL_MS = 1000; // update orderbook movement every 1s
const LIQUIDITY_MIN = 20000; // min QTY per level
const LIQUIDITY_MAX = 400000; // max QTY per level
const PRICE_SMOOTHING = 0.2; // 0..1, how strongly to follow external price (0 = no change, 1 = snap)

const EXTERNAL_SYMBOL = process.env.EXTERNAL_SYMBOL || 'animeusdt'; // default 'trumpusdt'

// External websocket feeds
const BINANCE_WSS = `wss://stream.binance.com:9443/ws/${EXTERNAL_SYMBOL}@trade`;

const TOKO_WSS = 'wss://stream-toko.2meta.app/ws/usdtidr@trade'; // user-provided

const BASE_COIN = process.env.BASE_COIN || 'ANIME';
const QUOTE_COIN = 'idr'; // tetap idr

// In-memory state
let balances = {
    [BASE_COIN]: START_BASE,
    [QUOTE_COIN]: START_IDR,
};

let midPrice = 0; // TRUMP/IDR mid price
let externalPrice = null;
let usdt_idr = null;
let totalUnrealizedPnL = 0;
let totalBase = 0;
let avgPrice = 0; // average price of trades

let orderbook = {
    bids: [], // [{price, qty, id, owner: 'mm'}]
    asks: []
};

let txLog = [];
let clientIdCounter = 1;

// Utility
function randBetween(a, b) {
    return a + Math.random() * (b - a);
}

function formatNum(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(3) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(3) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(3) + 'K';
    return n.toFixed(6);
}

function generateOrderbook(mid) {
    const spread = SPREAD_PCT;
    const topBid = mid * (1 - spread / 2);
    const topAsk = mid * (1 + spread / 2);

    const bids = [];
    const asks = [];

    // geometric steps away from top level to deeper levels
    const depthFactor = 1.0008; // controls price gaps between levels

    for (let i = 0; i < LEVELS; i++) {
        const priceBid = topBid / Math.pow(depthFactor, i);
        const priceAsk = topAsk * Math.pow(depthFactor, i);
        const qtyBid = parseFloat(randBetween(LIQUIDITY_MIN, LIQUIDITY_MAX).toFixed(6));
        const qtyAsk = parseFloat(randBetween(LIQUIDITY_MIN, LIQUIDITY_MAX).toFixed(6));

        bids.push({ id: 'mm-' + (clientIdCounter++), price: priceBid, qty: qtyBid, owner: 'mm' });
        asks.push({ id: 'mm-' + (clientIdCounter++), price: priceAsk, qty: qtyAsk, owner: 'mm' });
    }

    // sort
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    return { bids, asks };
}

function rebuildOrderbook() {
    orderbook = generateOrderbook(midPrice);
}

// Matching engine for market orders
function matchMarketOrder(side, size) {
    // side = 'buy' means taker wants to buy TRUMP => consume asks
    // side = 'sell' means taker wants to sell TRUMP => consume bids
    let remain = size;
    let trades = [];
    if (side === 'buy') {
        while (remain > 1e-9 && orderbook.asks.length > 0) {
            const top = orderbook.asks[0];
            const take = Math.min(remain, top.qty);
            // execute: taker buys TRUMP, so mm sells TRUMP
            trades.push({ price: top.price, qty: take, side: 'buy' });
            top.qty -= take;
            remain -= take;
            if (top.qty <= 1e-9) orderbook.asks.shift();
        }
    } else {
        while (remain > 1e-9 && orderbook.bids.length > 0) {
            const top = orderbook.bids[0];
            const take = Math.min(remain, top.qty);
            // taker sells TRUMP, so mm buys TRUMP
            trades.push({ price: top.price, qty: take, side: 'sell' });
            top.qty -= take;
            remain -= take;
            if (top.qty <= 1e-9) orderbook.bids.shift();
        }
    }

    // update mm balances based on trades
    // For mm: if mm sold TRUMP (taker buy), mm.TRUMP -= qty, mm.idr += qty*price
    // if mm bought TRUMP (taker sell), mm.TRUMP += qty, mm.idr -= qty*price
    
    let totalIDR = 0;
    let unrealizedPnLTrade = 0;
    let totalPrice = 0;
    trades.forEach(t => {
        if (t.side === 'buy') { // mm sold TRUMP
            balances[BASE_COIN] -= t.qty;
            balances.idr += t.qty * t.price;
            totalBase -= t.qty;
            totalIDR += t.qty * t.price;
            totalUnrealizedPnL += (t.price - midPrice) * t.qty;
            unrealizedPnLTrade = (t.price - midPrice) * t.qty; // PnL for this trade

        } else { // mm bought TRUMP
            balances[BASE_COIN] += t.qty;
            balances.idr -= t.qty * t.price;
            totalBase += t.qty;
            totalIDR -= t.qty * t.price;
            totalUnrealizedPnL += (midPrice - t.price) * t.qty;
            unrealizedPnLTrade = (midPrice - t.price) * t.qty; // PnL for this trade
        }

        totalPrice += t.price; // accumulate price for avg calculation

        txLog.unshift({ ts: Date.now(), price: t.price, qty: t.qty, side: t.side, unrealizedPnLTrade: unrealizedPnLTrade });
        if (txLog.length > 200) txLog.pop();
    });

    avgPrice = totalBase !== 0 ? (totalPrice / trades.length) : 0; // average price of trades
    // avgPrice = (avgPrice * (totalBase - trades.reduce((sum, t) => sum + t.qty, 0)) + trades.reduce((sum, t) => sum + t.price * t.qty, 0)) / totalBase;

    return { trades, filled: size - remain, totalBase, totalIDR };
}

// Periodic orderbook drift towards external midPrice changes
function driftOrderbookTowards(newMid) {
    // move each price a bit towards where it would be for newMid
    const newOB = generateOrderbook(newMid);
    // apply smoothing
    for (let i = 0; i < LEVELS; i++) {
        if (orderbook.bids[i] && newOB.bids[i]) {
            orderbook.bids[i].price = orderbook.bids[i].price * (1 - PRICE_SMOOTHING) + newOB.bids[i].price * PRICE_SMOOTHING;
            // keep qty but slightly randomize
            orderbook.bids[i].qty = Math.max(0.000001, orderbook.bids[i].qty * (0.95 + Math.random() * 0.1));
        }
        if (orderbook.asks[i] && newOB.asks[i]) {
            orderbook.asks[i].price = orderbook.asks[i].price * (1 - PRICE_SMOOTHING) + newOB.asks[i].price * PRICE_SMOOTHING;
            orderbook.asks[i].qty = Math.max(0.000001, orderbook.asks[i].qty * (0.95 + Math.random() * 0.1));
        }
    }

    // resort
    orderbook.bids.sort((a, b) => b.price - a.price);
    orderbook.asks.sort((a, b) => a.price - b.price);
}

// Setup Express + static
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); // reuse same server for ws
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
    res.json({ balances, orderbook, midPrice, txLog: txLog.slice(0, 50) });
});

// endpoint to trigger market order (simulated external taker)
app.post('/api/market', (req, res) => {
    const side = req.body.side; // 'buy' or 'sell'
    const qty = parseFloat(req.body.qty);
    if (!['buy', 'sell'].includes(side) || !qty || qty <= 0) {
        return res.status(400).json({ error: 'invalid' });
    }
    const result = matchMarketOrder(side, qty);
    broadcastState();
    res.json(result);
});

// serve index.html from public/index.html (we provide content later)

// Websocket to clients (frontend)
function broadcastState() {
    const payload = JSON.stringify({ type: 'state', balances, orderbook, midPrice, txLog: txLog.slice(0, 50), totalUnrealizedPnL, totalBase, avgPrice });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
}

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello' }));
    ws.send(JSON.stringify({ type: 'state', balances, orderbook, midPrice, txLog: txLog.slice(0, 50), totalUnrealizedPnL, totalBase, avgPrice }));
});

// Connect to external feeds
function connectBinance() {
    const ws = new WebSocket(BINANCE_WSS);
    ws.on('open', () => console.log('Connected to Binance trade stream'));
    ws.on('message', (msg) => {
        try {
            console.log('Binance message: ', msg.toString());
            const d = JSON.parse(msg.toString());
            if (d && d.p) {
                externalPrice = parseFloat(d.p);
                recomputeMid();
            }
        } catch (e) { }
    });
    ws.on('close', () => { console.log('Binance WS closed, reconnecting in 2s'); setTimeout(connectBinance, 2000); });
    ws.on('error', (e) => { console.error('Binance WS error', e); });
}

function connectTokocrypto() {
    const ws = new WebSocket(TOKO_WSS);
    ws.on('open', () => {
        console.log('Connected to Tokocrypto stream');
        // subscribe usdtidr@trade per user message
        ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: ['usdtidr@trade'], id: 1 }));
    });
    ws.on('message', (msg) => {
        try {
            // console.log('Tokocrypto message:', msg.toString());
            const d = JSON.parse(msg.toString());
            // handle trade events: object with e:'trade' and p price
            if (d && d.e === 'trade' && d.p) {
                usdt_idr = parseFloat(d.p);
                recomputeMid();
            }
        } catch (e) { }
    });
    ws.on('close', () => { console.log('Tokocrypto WS closed, reconnecting in 2s'); setTimeout(connectTokocrypto, 2000); });
    ws.on('error', (e) => { console.error('Tokocrypto WS error', e); });
}

function recomputeMid() {
    if (externalPrice && usdt_idr) {
        const newMid = externalPrice * usdt_idr;
        // smooth midPrice changes
        if (!midPrice) midPrice = newMid;
        midPrice = midPrice * (1 - PRICE_SMOOTHING) + newMid * PRICE_SMOOTHING;
    }
}

// Start external connections
connectBinance();
connectTokocrypto();

// Initialize orderbook once we have a midPrice (poll until available)
const initInterval = setInterval(() => {
    if (midPrice && midPrice > 0) {
        rebuildOrderbook();
        broadcastState();
        clearInterval(initInterval);
    }
}, 200);

// Main periodic updates: drift book and broadcast
setInterval(() => {
    if (midPrice && midPrice > 0 && orderbook.bids.length > 0) {
        const newMid = midPrice; // already smoothed from recomputeMid
        driftOrderbookTowards(newMid);
        broadcastState();
    }
}, UPDATE_INTERVAL_MS);

server.listen(PORT, () => console.log('Server listening on http://localhost:' + PORT));