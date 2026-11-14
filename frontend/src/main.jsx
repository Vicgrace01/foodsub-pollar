import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { PollarProvider, usePollar } from '@pollar/react';
import '@pollar/react/styles.css';
import './pollar.css';

const config = window.FOODSUB_CONFIG || {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEND_TIMEOUT_MS = 120000;
const HASH_WAIT_MS   = 30000;
const VERIFY_TIMEOUT_MS = 45000;

function shortAddress(a) {
  return a ? `${a.slice(0, 7)}…${a.slice(-6)}` : '';
}

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
  const pollar = usePollar();
  const {
    isAuthenticated, verified, wallet, hasWallet, createWallet,
    openLoginModal, openWalletBalanceModal, openTxHistoryModal, logout,
    sendPayment, runTx, getClient, configStatus, network,
  } = pollar;

  const [checkout, setCheckout] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [success, setSuccess] = useState(null);
  const [stage, setStage] = useState('');
  const [pollarActive, setPollarActive] = useState(false);

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
      const payload = e.detail || null;
      setCheckout(payload);
      checkoutRef.current = payload;
      setStatus(''); setError(''); setSuccess(null);
      setBusy(false); setStage(''); setPollarActive(false);
      txHashRef.current = null;
      attemptRef.current++;
    };
    window.addEventListener('foodsub:pollar:checkout', onOpen);
    return () => window.removeEventListener('foodsub:pollar:checkout', onOpen);
  }, []);

  useEffect(() => {
    let unsub;
    try {
      const client = getClient?.();
      if (client?.onTransactionStateChange) {
        unsub = client.onTransactionStateChange((state) => {
          if (!state) return;
          if (state.hash) txHashRef.current = state.hash;
          switch (state.step) {
            case 'building': setStage('Building transaction on Pollar…'); break;
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
              setError(`Pollar error${state.phase ? ` (${state.phase})` : ''}: ${state.code || ''} ${state.message || ''}`.trim());
              break;
            default: break;
          }
        });
      }
    } catch (e) {
      console.warn('tx state subscribe unavailable', e);
    }
    return () => { try { unsub && unsub(); } catch { /* noop */ } };
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

  // When login completes, our modal can return
  useEffect(() => {
    if (isAuthenticated && pollarActive) setPollarActive(false);
  }, [isAuthenticated, pollarActive]);

  // Fallback: if user closed Pollar's modal without acting, our modal returns on focus
  useEffect(() => {
    if (!pollarActive || isAuthenticated) return;
    const onFocus = () => setTimeout(() => {
      if (!isAuthenticated) setPollarActive(false);
    }, 800);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [pollarActive, isAuthenticated]);

  // Sync FoodSub logout → Pollar logout
  useEffect(() => {
    const onFoodsubLogout = () => {
      attemptRef.current++;
      setCheckout(null); checkoutRef.current = null;
      setStatus(''); setError(''); setStage(''); setSuccess(null);
      setBusy(false); setWalletBusy(false); setPollarActive(false);
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
          setStage('Submitted. Waiting for Stellar Horizon to index…');
          await sleep(2000);
          continue;
        }
        throw new Error(body.error || body.message || `Backend verification failed (${res.status})`);
      } catch (e) {
        if (String(e.message).includes('verification failed') || String(e.message).includes('does not match')) throw e;
        last = e.message;
        await sleep(2000);
      }
    }
    throw new Error(last || 'Verification timed out. Check Pollar transaction history.');
  }

  async function retryWalletSetup() {
    if (typeof createWallet !== 'function') return;
    setError(''); setStatus('Preparing your Pollar wallet…'); setWalletBusy(true);
    try {
      await createWallet();
      setStatus('Wallet setup requested.');
    } catch (e) {
      setError(e?.message || 'Could not create your Pollar wallet.');
      setStatus('');
    } finally { setWalletBusy(false); }
  }

  function handleConnect() {
    if (typeof window.foodSubToast === 'function') {
      window.foodSubToast('Opening Pollar login — look for the Pollar popup.');
    }
    setPollarActive(true);
    try { openLoginModal(); } catch (e) {
      console.warn('openLoginModal', e);
      setPollarActive(false);
      setError(e?.message || 'Could not open Pollar login modal.');
    }
  }

  async function payWithPollar() {
    setError(''); setStatus(''); setSuccess(null);
    const order = checkoutRef.current;
    if (!order) return;
    if (!merchantAddress) { setError('FoodSub receiving address not configured.'); return; }
    if (!verified) { setError('Pollar session is still verifying. Wait a second and try again.'); return; }
    if (!walletAddress.startsWith('G')) { setError('Only classic Stellar G-address wallets are supported.'); return; }
    if (wallet?.existsOnStellar === false) { setError('Wallet not active on Stellar yet.'); return; }
    if (!walletReady) { setError('Wallet not ready. Wait for provisioning to finish.'); return; }
    if (network !== 'testnet') { setError('Only Stellar testnet is supported in this build.'); return; }

    const attempt = ++attemptRef.current;
    txHashRef.current = null;
    setBusy(true);
    setPollarActive(true);
    setStage('Waiting for confirmation in Pollar…');
    if (typeof window.foodSubToast === 'function') {
      window.foodSubToast('Look for the Pollar confirmation popup and press Confirm.');
    }

    const params = {
      destination: merchantAddress,
      amount: String(order.amount_xlm),
      asset: { type: 'native' },
    };
    const opts = { memo: { type: 'text', value: String(order.payment_memo) } };

    try {
      const call =
        typeof runTx === 'function'
          ? runTx('payment', params, opts)
          : sendPayment({ ...params, chain: 'STELLAR', options: opts });

      const outcome = await Promise.race([
        Promise.resolve(call),
        sleep(SEND_TIMEOUT_MS).then(() => ({ __timeout: true })),
      ]);

      if (attempt !== attemptRef.current) return;

      // Pollar's modal is closed. Bring ours back with progress.
      setPollarActive(false);

      if (outcome?.__timeout) {
        const late = await waitForHash(HASH_WAIT_MS);
        if (late) txHashRef.current = late;
        else throw new Error('Pollar did not return within 2 minutes. If you confirmed, the payment may still land — open Pollar history before retrying.');
      } else if (outcome?.status === 'error') {
        throw new Error(`Pollar rejected the payment: ${describeOutcome(outcome)}`);
      } else if (outcome?.status === 'cosign_pending') {
        throw new Error('Wallet needs an extra co-sign step. Approve it in Pollar, then check history before retrying.');
      }

      if (outcome?.hash) txHashRef.current = outcome.hash;
      if (!txHashRef.current) {
        const late = await waitForHash(HASH_WAIT_MS);
        if (late) txHashRef.current = late;
      }
      if (attempt !== attemptRef.current) return;

      if (!txHashRef.current) {
        const reason = describeOutcome(outcome);
        if (String(reason).includes('SDK_CONFIRMATION_DECLINED') || String(reason).includes('DECLINED')) {
          throw new Error('You declined the payment in Pollar. Nothing was sent.');
        }
        if (String(reason).includes('SDK_WALLET_NOT_READY')) {
          throw new Error('Wallet still activating on Stellar. Wait a few seconds and press Pay again.');
        }
        throw new Error(`Pollar returned no transaction hash (${reason}). Nothing was submitted.`);
      }

      setStage(`Submitted ${txHashRef.current.slice(0, 10)}… verifying with FoodSub…`);
      const result = await verifyWithBackend(order, txHashRef.current, walletAddress);
      if (attempt !== attemptRef.current) return;

      setSuccess({ orderId: order.order_id, txHash: txHashRef.current });
      setStatus(result.message || 'Payment verified.');
      setStage('');
      window.dispatchEvent(new CustomEvent('foodsub:pollar:paid', {
        detail: { orderId: order.order_id, txHash: txHashRef.current },
      }));
      if (typeof window.foodSubToast === 'function') {
        window.foodSubToast(`Payment verified for order #${order.order_id} 🎉`);
      }
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setPollarActive(false);
      setError(err?.message || 'Payment failed.');
      setStage('');
      if (txHashRef.current) {
        setStatus(`Submitted but not yet confirmed. Hash: ${txHashRef.current.slice(0, 20)}…`);
      }
    } finally {
      if (attempt === attemptRef.current) setBusy(false);
    }
  }

  function stopWaiting() {
    attemptRef.current++;
    setBusy(false);
    setStage('');
    setPollarActive(false);
    setStatus('Stopped waiting. If you confirmed in Pollar, check transaction history before retrying.');
  }

  function closeModal() {
    if (busy && !window.confirm('A payment may still be in progress. Close anyway? Check Pollar history before retrying.')) return;
    attemptRef.current++;
    setCheckout(null); checkoutRef.current = null;
    setStatus(''); setError(''); setStage(''); setSuccess(null); setBusy(false);
    setPollarActive(false);
  }

  async function handleLogout() {
    try { if (typeof logout === 'function') await logout(); } catch (e) { console.warn(e); }
    attemptRef.current++;
    setCheckout(null); checkoutRef.current = null;
    setStatus(''); setError(''); setStage(''); setSuccess(null);
    setBusy(false); setWalletBusy(false); setPollarActive(false);
    createStarted.current = false;
  }

  if (!publishableKeyReady) {
    return <div className="pollar-nav-state" title="Set POLLAR_PUBLISHABLE_KEY">Pollar not configured</div>;
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
        <div
          className="pollar-overlay"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className="pollar-dialog">
            <button className="pollar-close" onClick={closeModal} aria-label="Close">×</button>
            <div className="pollar-label">FoodSub · Pollar checkout</div>
            <h2>{success ? 'Order paid' : 'Complete your order'}</h2>

            {!success && (
              <>
                <div className="pollar-meta">
                  <div><span className="pollar-label">Order</span><br /><strong>#{checkout.order_id} · {checkout.package}</strong></div>
                  <div style={{ marginTop: 12 }}><span className="pollar-label">FoodSub price</span><br /><strong>US$ {Number(checkout.amount_usd).toFixed(2)}</strong></div>
                  <div style={{ marginTop: 12 }}><span className="pollar-label">Testnet payment</span><br /><strong>{checkout.amount_xlm} XLM</strong></div>
                </div>
                <p className="pollar-note">Demo rate: 1 USD = {config.demoXlmPerUsd || '1'} XLM. Testnet XLM has no real-world value.</p>
              </>
            )}

            {success ? (
              <>
                <div className="pollar-status" style={{ background: '#e8f5e0', borderLeftColor: '#2f7d32' }}>
                  <strong>✓ Payment verified on Stellar testnet.</strong><br />
                  Order #{success.orderId} is now marked <code>paid</code>.<br />
                  <span style={{ fontSize: '.78rem', wordBreak: 'break-all' }}>tx: {success.txHash}</span>
                </div>
                <button className="pollar-action" onClick={closeModal}>Done</button>
              </>
            ) : !isAuthenticated ? (
              <button className="pollar-action" onClick={handleConnect}>Connect / sign in with Pollar</button>
            ) : (
              <>
                <div className="pollar-address">
                  <strong>Connected wallet</strong><br />
                  {walletAddress || (walletBusy ? 'Creating wallet…' : 'Wallet not ready')}
                </div>
                {walletBusy && <p>Preparing your Pollar wallet…</p>}
                {!walletReady && !walletBusy && hasWallet === false && (
                  <button className="pollar-secondary" onClick={retryWalletSetup}>Retry wallet setup</button>
                )}
                {walletReady && !busy && (
                  <button className="pollar-action" onClick={payWithPollar}>
                    Pay {checkout.amount_xlm} XLM with Pollar
                  </button>
                )}
                {walletReady && busy && (
                  <>
                    <button className="pollar-action" disabled>Processing…</button>
                    <button className="pollar-secondary" onClick={stopWaiting}>Stop waiting (check history first)</button>
                  </>
                )}
                <button className="pollar-secondary" onClick={openTxHistoryModal}>View Pollar history</button>
                <button className="pollar-secondary" onClick={handleLogout}>Disconnect Pollar</button>
              </>
            )}

            {wallet?.custody === 'smart' && (
              <div className="pollar-status pollar-error">Passkey smart wallets (C-addresses) are not supported. Use email or social login.</div>
            )}
            {!merchantAddress && <div className="pollar-status pollar-error">Merchant wallet not configured.</div>}
            {stage && <div className="pollar-status">{stage}</div>}
            {status && <div className="pollar-status">{status}</div>}
            {error && <div className="pollar-status pollar-error">{error}</div>}
            {configStatus === 'error' && <div className="pollar-status pollar-error">Pollar config error. Check app and allowed origin.</div>}
            <p className="pollar-note">Network: {network || 'testnet'}. Order is marked paid only after Stellar Horizon verification.</p>
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