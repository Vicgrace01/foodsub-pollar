import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { PollarProvider, usePollar } from '@pollar/react';
import '@pollar/react/styles.css';
import './pollar.css';

const config = window.FOODSUB_CONFIG || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEND_TIMEOUT_MS = 120000;
const HASH_WAIT_MS = 30000;
const VERIFY_TIMEOUT_MS = 45000;

function shortAddress(a) { return a ? `${a.slice(0, 7)}…${a.slice(-6)}` : ''; }

function describeOutcome(o) {
  if (!o) return 'No response from Pollar.';
  const bits = [];
  if (o.code) bits.push(o.code);
  if (o.resultCode) bits.push(o.resultCode);
  if (o.message) bits.push(o.message);
  if (o.details) bits.push(typeof o.details === 'string' ? o.details : JSON.stringify(o.details));
  return bits.length ? bits.join(' — ') : `status: ${o.status || 'unknown'}`;
}

function PollarExperience() {
  const {
    isAuthenticated, verified, wallet, hasWallet, createWallet,
    openLoginModal, openWalletBalanceModal, openTxHistoryModal, logout,
    sendPayment, runTx, getClient, configStatus, network,
  } = usePollar();

  const [checkout, setCheckout] = useState(null);
  const [method, setMethod] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [success, setSuccess] = useState(null);
  const [stage, setStage] = useState('');
  const [pollarActive, setPollarActive] = useState(false);
  const [zcashInvoice, setZcashInvoice] = useState(null);

  const createStarted = useRef(false);
  const attemptRef = useRef(0);
  const txHashRef = useRef(null);
  const checkoutRef = useRef(null);

  const merchantAddress = config.pollarMerchantAddress || '';
  const publishableKeyReady = Boolean(config.pollarPublishableKey);
  const walletAddress = wallet?.address || '';
  const walletReady =
    Boolean(walletAddress.startsWith('G')) &&
    wallet?.existsOnStellar !== false &&
    (!wallet?.provisioning || wallet.provisioning === 'READY');

  useEffect(() => {
    const onOpen = (e) => {
      setCheckout(e.detail || null);
      checkoutRef.current = e.detail || null;
      setMethod(null); setZcashInvoice(null);
      setStatus(''); setError(''); setSuccess(null);
      setBusy(false); setStage(''); setPollarActive(false);
      txHashRef.current = null;
      attemptRef.current++;
    };
    window.addEventListener('foodsub:pollar:checkout', onOpen);
    return () => window.removeEventListener('foodsub:pollar:checkout', onOpen);
  }, []);

  // Polling for Zcash confirmation
  useEffect(() => {
    if (!zcashInvoice?.order_id) return;
    let cancelled = false;
    (async () => {
      const deadline = Date.now() + 10 * 60 * 1000;
      while (!cancelled && Date.now() < deadline) {
        try {
          const r = await fetch(`/api/orders/${zcashInvoice.order_id}`);
          if (r.ok) {
            const data = await r.json();
            if (data.order?.status === 'paid') {
              setSuccess({ orderId: zcashInvoice.order_id, method: 'zcash', txHash: data.order.tx_hash });
              setZcashInvoice(null);
              if (typeof window.foodSubToast === 'function') window.foodSubToast('Zcash payment confirmed 🎉');
              return;
            }
            if (data.order?.status === 'expired') {
              setError('Invoice expired. Create a new one and try again.');
              setZcashInvoice(null);
              return;
            }
          }
        } catch {}
        await sleep(5000);
      }
    })();
    return () => { cancelled = true; };
  }, [zcashInvoice]);

  useEffect(() => {
    let unsub;
    try {
      const client = getClient?.();
      if (client?.onTransactionStateChange) {
        unsub = client.onTransactionStateChange((state) => {
          if (!state) return;
          if (state.hash) txHashRef.current = state.hash;
          switch (state.step) {
            case 'building': setStage('Building transaction…'); break;
            case 'built':
            case 'signing': setStage('Waiting for you to confirm in Pollar…'); break;
            case 'signed': setStage('Signed. Submitting…'); break;
            case 'submitting': setStage('Submitting to Stellar testnet…'); break;
            case 'signing-submitting':
            case 'building-signing-submitting': setStage('Building, signing, submitting…'); break;
            case 'awaiting_cosign': setStage('Waiting for co-sign approval…'); break;
            case 'submitted': setStage(`Submitted ${String(state.hash || '').slice(0, 10)}… awaiting ledger`); break;
            case 'success':
              setStage('Confirmed on Stellar');
              if (state.hash) txHashRef.current = state.hash;
              break;
            case 'error':
              setStage('');
              setError(`Pollar error: ${state.code || ''} ${state.message || ''}`.trim());
              break;
            default: break;
          }
        });
      }
    } catch (e) { console.warn('tx state subscribe unavailable', e); }
    return () => { try { unsub && unsub(); } catch {} };
  }, [getClient]);

  useEffect(() => {
    if (!isAuthenticated || walletReady || createStarted.current || typeof createWallet !== 'function') return;
    if (hasWallet === false || hasWallet === undefined) {
      createStarted.current = true;
      setWalletBusy(true);
      Promise.resolve(createWallet())
        .then(() => setStatus('Pollar wallet is being prepared…'))
        .catch((err) => setError(err?.message || 'Could not create your Pollar wallet.'))
        .finally(() => setWalletBusy(false));
    }
  }, [isAuthenticated, walletReady, hasWallet, createWallet]);

  useEffect(() => { if (!isAuthenticated) createStarted.current = false; }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated && pollarActive) setPollarActive(false);
  }, [isAuthenticated, pollarActive]);

  useEffect(() => {
    if (!pollarActive || isAuthenticated) return;
    const onFocus = () => setTimeout(() => { if (!isAuthenticated) setPollarActive(false); }, 800);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [pollarActive, isAuthenticated]);

  useEffect(() => {
    const onFoodsubLogout = () => {
      attemptRef.current++;
      setCheckout(null); checkoutRef.current = null;
      setStatus(''); setError(''); setStage(''); setSuccess(null); setZcashInvoice(null);
      setBusy(false); setWalletBusy(false); setPollarActive(false); setMethod(null);
      createStarted.current = false;
      try { if (typeof logout === 'function') logout(); } catch (e) { console.warn('Pollar logout', e); }
    };
    window.addEventListener('foodsub:logout', onFoodsubLogout);
    return () => window.removeEventListener('foodsub:logout', onFoodsubLogout);
  }, [logout]);

  const waitForHash = useCallback(async (deadlineMs) => {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
      if (txHashRef.current) return txHashRef.current;
      await sleep(700);
    }
    return txHashRef.current;
  }, []);

  async function verifyWithBackend(order, txHash, payer) {
    const end = Date.now() + VERIFY_TIMEOUT_MS;
    let last = null;
    while (Date.now() < end) {
      try {
        const res = await fetch('/api/pollar/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: order.order_id, tx_hash: txHash, payer_address: payer }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.paid) return body;
        if (res.status === 202 && body.pending) {
          setStage('Waiting for Stellar Horizon to index…');
          await sleep(2000);
          continue;
        }
        throw new Error(body.error || body.message || `Verification failed (${res.status})`);
      } catch (e) {
        if (String(e.message).includes('verification failed') || String(e.message).includes('does not match')) throw e;
        last = e.message;
        await sleep(2000);
      }
    }
    throw new Error(last || 'Verification timed out.');
  }

  async function retryWalletSetup() {
    if (typeof createWallet !== 'function') return;
    setError(''); setStatus('Preparing your Pollar wallet…'); setWalletBusy(true);
    try { await createWallet(); setStatus('Wallet setup requested.'); }
    catch (e) { setError(e?.message || 'Could not create wallet.'); setStatus(''); }
    finally { setWalletBusy(false); }
  }

  function handleConnect() {
    setPollarActive(true);
    try { openLoginModal(); }
    catch (e) { setPollarActive(false); setError(e?.message || 'Could not open Pollar login modal.'); }
  }

  async function payWithPollar() {
    setError(''); setStatus(''); setSuccess(null);
    const order = checkoutRef.current;
    if (!order) return;
    if (!merchantAddress) { setError('Merchant address not configured.'); return; }
    if (!verified) { setError('Pollar session still verifying. Wait a second.'); return; }
    if (!walletAddress.startsWith('G')) { setError('Only classic Stellar G-address wallets supported.'); return; }
    if (!walletReady) { setError('Wallet not ready.'); return; }
    if (network !== 'testnet') { setError('Testnet only.'); return; }

    const attempt = ++attemptRef.current;
    txHashRef.current = null;
    setBusy(true); setPollarActive(true);
    setStage('Waiting for confirmation in Pollar…');

    const params = { destination: merchantAddress, amount: String(order.amount_xlm), asset: { type: 'native' } };
    const opts = { memo: { type: 'text', value: String(order.payment_memo) } };

    try {
      const call = typeof runTx === 'function'
        ? runTx('payment', params, opts)
        : sendPayment({ ...params, chain: 'STELLAR', options: opts });
      const outcome = await Promise.race([Promise.resolve(call), sleep(SEND_TIMEOUT_MS).then(() => ({ __timeout: true }))]);
      if (attempt !== attemptRef.current) return;
      setPollarActive(false);

      if (outcome?.__timeout) {
        const late = await waitForHash(HASH_WAIT_MS);
        if (late) txHashRef.current = late;
        else throw new Error('Pollar timed out. Check history.');
      } else if (outcome?.status === 'error') {
        throw new Error(`Pollar rejected: ${describeOutcome(outcome)}`);
      }
      if (outcome?.hash) txHashRef.current = outcome.hash;
      if (!txHashRef.current) {
        const late = await waitForHash(HASH_WAIT_MS);
        if (late) txHashRef.current = late;
      }
      if (attempt !== attemptRef.current) return;
      if (!txHashRef.current) {
        const reason = describeOutcome(outcome);
        if (String(reason).includes('DECLINED')) throw new Error('You declined in Pollar. Nothing sent.');
        throw new Error(`No tx hash (${reason}).`);
      }

      setStage(`Submitted ${txHashRef.current.slice(0, 10)}…`);
      const result = await verifyWithBackend(order, txHashRef.current, walletAddress);
      if (attempt !== attemptRef.current) return;

      setSuccess({ orderId: order.order_id, method: 'pollar', txHash: txHashRef.current });
      setStatus(result.message || 'Payment verified.');
      setStage('');
      if (typeof window.foodSubToast === 'function') window.foodSubToast(`Order #${order.order_id} paid 🎉`);
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setPollarActive(false);
      setError(err?.message || 'Payment failed.');
      setStage('');
    } finally {
      if (attempt === attemptRef.current) setBusy(false);
    }
  }

  async function payWithZcash() {
    setError(''); setStatus(''); setSuccess(null);
    const order = checkoutRef.current;
    if (!order) return;
    setBusy(true); setStage('Creating Zcash invoice…');
    try {
      const r = await fetch('/api/zcash/create-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: order.order_id }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Invoice failed (${r.status})`);
      setZcashInvoice({ ...data, order_id: order.order_id });
      setStage('Awaiting payment — scan the QR or open the checkout link.');
    } catch (e) {
      setError(e?.message || 'Could not create Zcash invoice.');
      setStage('');
    } finally {
      setBusy(false);
    }
  }

  function stopWaiting() {
    attemptRef.current++;
    setBusy(false); setStage(''); setPollarActive(false);
    setStatus('Stopped waiting. Check Pollar history before retrying.');
  }

  function closeModal() {
    if ((busy || zcashInvoice) && !window.confirm('Payment may still be in progress. Close anyway?')) return;
    attemptRef.current++;
    setCheckout(null); checkoutRef.current = null;
    setStatus(''); setError(''); setStage(''); setSuccess(null);
    setBusy(false); setPollarActive(false); setZcashInvoice(null); setMethod(null);
  }

  async function handleLogout() {
    try { if (typeof logout === 'function') await logout(); } catch {}
    attemptRef.current++;
    setCheckout(null); checkoutRef.current = null;
    setStatus(''); setError(''); setStage(''); setSuccess(null); setZcashInvoice(null);
    setBusy(false); setWalletBusy(false); setPollarActive(false); setMethod(null);
    createStarted.current = false;
  }

  if (!publishableKeyReady) {
    return <div className="pollar-nav-state">Pollar not configured</div>;
  }

  return (
    <>
      <button
        className={`pollar-nav-btn ${isAuthenticated ? 'connected' : ''}`}
        onClick={() => (isAuthenticated ? openWalletBalanceModal() : handleConnect())}
      >
        {isAuthenticated && walletAddress
          ? `Pollar · ${shortAddress(walletAddress)}`
          : isAuthenticated ? 'Pollar wallet' : 'Connect Pollar'}
      </button>

      {checkout && !pollarActive && createPortal(
        <div className="pollar-overlay" role="dialog" aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="pollar-dialog">
            <button className="pollar-close" onClick={closeModal} aria-label="Close">×</button>
            <div className="pollar-label">FoodSub · Checkout</div>
            <h2>{success ? 'Order paid' : 'Complete your order'}</h2>

            {!success && (
              <div className="pollar-meta">
                <div><span className="pollar-label">Order</span><br /><strong>#{checkout.order_id} · {checkout.package}</strong></div>
                <div style={{ marginTop: 12 }}><span className="pollar-label">Price</span><br /><strong>US$ {Number(checkout.amount_usd).toFixed(2)}</strong></div>
              </div>
            )}

            {success ? (
              <>
                <div className="pollar-status" style={{ background: '#e8f5e0', borderLeftColor: '#2f7d32' }}>
                  <strong>✓ Verified on testnet.</strong><br />
                  Order #{success.orderId} · <code>{success.method}</code> · <code>paid</code>
                  {success.txHash && <><br /><span style={{ fontSize: '.7rem', wordBreak: 'break-all' }}>tx: {success.txHash}</span></>}
                </div>
                <button className="pollar-action" onClick={closeModal}>Done</button>
              </>
            ) : !method ? (
              <>
                <p className="pollar-note">Choose a payment method. Both settle on testnet only.</p>
                <button className="pollar-action" onClick={() => setMethod('pollar')}>
                  Pay with Pollar (Stellar XLM)
                </button>
                <button className="pollar-action" style={{ background: '#4a2a91' }} onClick={() => setMethod('zcash')}>
                  Pay with Zcash (Orchard shielded)
                </button>
              </>
            ) : method === 'pollar' ? (
              <>
                {!isAuthenticated ? (
                  <button className="pollar-action" onClick={handleConnect}>Connect / sign in with Pollar</button>
                ) : (
                  <>
                    <div className="pollar-address">
                      <strong>Pollar wallet</strong><br />{walletAddress || (walletBusy ? 'Creating…' : 'Not ready')}
                    </div>
                    {walletBusy && <p>Preparing your Pollar wallet…</p>}
                    {!walletReady && !walletBusy && hasWallet === false && (
                      <button className="pollar-secondary" onClick={retryWalletSetup}>Retry wallet setup</button>
                    )}
                    {walletReady && !busy && (
                      <button className="pollar-action" onClick={payWithPollar}>
                        Pay {checkout.amount_xlm} XLM
                      </button>
                    )}
                    {walletReady && busy && (
                      <>
                        <button className="pollar-action" disabled>Processing…</button>
                        <button className="pollar-secondary" onClick={stopWaiting}>Stop waiting</button>
                      </>
                    )}
                    <button className="pollar-secondary" onClick={openTxHistoryModal}>View Pollar history</button>
                    <button className="pollar-secondary" onClick={handleLogout}>Disconnect Pollar</button>
                  </>
                )}
                <button className="pollar-secondary" onClick={() => { setMethod(null); setStatus(''); setError(''); setStage(''); }}>
                  ← Change method
                </button>
              </>
            ) : (
              <>
                {!zcashInvoice ? (
                  <>
                    <p>An invoice is generated and paid to a shielded testnet address. You scan the QR with any testnet Zcash wallet (Orchard or Sapling), and the server confirms on-chain via webhook.</p>
                    <button className="pollar-action" style={{ background: '#4a2a91' }} disabled={busy} onClick={payWithZcash}>
                      {busy ? 'Creating invoice…' : 'Create Zcash invoice'}
                    </button>
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: '.9rem' }}>
                      Scan this QR with your Zcash testnet wallet, or open the hosted checkout.
                    </p>
                    <div style={{ textAlign: 'center', margin: '12px 0' }}>
                      <img
                        alt="Zcash payment QR"
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(zcashInvoice.zcash_uri || zcashInvoice.payment_address || '')}`}
                        style={{ borderRadius: 12, background: '#fff', padding: 8 }}
                      />
                    </div>
                    <div className="pollar-address" style={{ fontSize: '.72rem' }}>
                      <strong>Memo</strong><br />{zcashInvoice.memo_code || '—'}<br /><br />
                      <strong>Amount</strong><br />{zcashInvoice.price_zec || '?'} ZEC<br /><br />
                      <strong>Address</strong><br />{zcashInvoice.payment_address || '—'}
                    </div>
                    {zcashInvoice.checkout_url && (
                      <a className="pollar-secondary" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
                         href={zcashInvoice.checkout_url} target="_blank" rel="noopener noreferrer">
                        Open CipherPay checkout page
                      </a>
                    )}
                    <div className="pollar-status">Waiting for on-chain confirmation… This dialog updates automatically.</div>
                    <button className="pollar-secondary" onClick={() => setZcashInvoice(null)}>Cancel invoice</button>
                  </>
                )}
                <button className="pollar-secondary" onClick={() => { setMethod(null); setZcashInvoice(null); setStatus(''); setError(''); setStage(''); }}>
                  ← Change method
                </button>
              </>
            )}

            {stage && <div className="pollar-status">{stage}</div>}
            {status && <div className="pollar-status">{status}</div>}
            {error && <div className="pollar-status pollar-error">{error}</div>}
            <p className="pollar-note">Testnet only. XLM and ZEC here have no real-world value.</p>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function App() {
  if (!config.pollarPublishableKey) return <div className="pollar-nav-state">Pollar key missing</div>;
  return (
    <PollarProvider client={{ apiKey: config.pollarPublishableKey, stellarNetwork: 'testnet' }}>
      <PollarExperience />
    </PollarProvider>
  );
}

const node = document.getElementById('pollar-root');
if (node) createRoot(node).render(<App />);