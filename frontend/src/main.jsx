import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { PollarProvider, usePollar } from '@pollar/react';
import '@pollar/react/styles.css';
import './pollar.css';

const config = window.FOODSUB_CONFIG || {};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PAYMENT_TIMEOUT_MS = 90000;
const VERIFY_TIMEOUT_MS = 30000;

function shortAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 7)}…${address.slice(-6)}`;
}

function PollarExperience() {
  const {
    isAuthenticated,
    wallet,
    hasWallet,
    createWallet,
    openLoginModal,
    openWalletBalanceModal,
    openTxHistoryModal,
    logout,
    sendPayment,
    getClient,
    configStatus,
    network,
  } = usePollar();

  const [checkout, setCheckout] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const createStarted = useRef(false);
  const paymentAttemptRef = useRef(0);

  const merchantAddress = config.pollarMerchantAddress || '';
  const publishableKeyReady = Boolean(config.pollarPublishableKey);
  const walletAddress = wallet?.address || '';
  const walletReady = Boolean(walletAddress.startsWith('G')) && wallet?.existsOnStellar !== false && (!wallet?.provisioning || wallet.provisioning === 'READY');

  useEffect(() => {
    const openCheckout = (event) => {
      setCheckout(event.detail || null);
      setStatus('');
      setError('');
      setBusy(false);
    };
    window.addEventListener('foodsub:pollar:checkout', openCheckout);
    return () => window.removeEventListener('foodsub:pollar:checkout', openCheckout);
  }, []);

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

  useEffect(() => {
    if (!isAuthenticated) createStarted.current = false;
  }, [isAuthenticated]);

  async function retryWalletSetup() {
    if (typeof createWallet !== 'function') return;
    setError('');
    setStatus('Preparing your Pollar wallet…');
    setWalletBusy(true);
    try {
      await createWallet();
      setStatus('Wallet setup requested.');
    } catch (err) {
      setError(err?.message || 'Could not create your Pollar wallet.');
      setStatus('');
    } finally {
      setWalletBusy(false);
    }
  }

  async function waitForTransaction(hash) {
    let client;
    try { client = getClient(); } catch (e) { return; }
    if (!client?.getTxStatus) { await pause(5000); return; }
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const result = await client.getTxStatus(hash);
        if (result?.status === 'SUCCESS') return;
        if (result?.status === 'FAILED') {
          throw new Error(`Stellar rejected the payment (${result.resultCode || 'transaction failed'}).`);
        }
      } catch (e) {
        if (e.message?.includes('Stellar rejected')) throw e;
        console.warn('getTxStatus transient error, retrying:', e);
      }
      await pause(2500);
    }
  }

  async function verifyFoodSubOrder(order, txHash, payerAddress) {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch('/api/pollar/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: order.order_id, tx_hash: txHash, payer_address: payerAddress }),
        });
        const result = await response.json().catch(() => ({}));
        if (response.ok && result.paid) return result;
        if (response.status === 202 && result.pending) {
          setStatus('Submitted. Waiting for Stellar Horizon to index…');
          await pause(2000);
          continue;
        }
        throw new Error(result.error || result.message || 'FoodSub could not verify this payment.');
      } catch (e) {
        if (e.message?.includes('could not verify') || e.message?.includes('not visible')) throw e;
        lastError = e.message;
        await pause(2000);
      }
    }
    throw new Error(lastError || 'Verification timed out. Check Pollar transaction history.');
  }

  async function payWithPollar() {
    setError('');
    setStatus('');
    if (!checkout) return;
    if (!merchantAddress) { setError('FoodSub receiving address not configured.'); return; }
    if (!walletAddress.startsWith('G')) { setError('Only classic Stellar G-address wallets are supported.'); return; }
    if (wallet?.existsOnStellar === false) { setError('Wallet not yet active on Stellar.'); return; }
    if (!walletReady) { setError('Wallet not ready yet.'); return; }
    if (network !== 'testnet') { setError('Only Stellar testnet is supported.'); return; }

    const attemptId = ++paymentAttemptRef.current;
    setBusy(true);
    setStatus('Confirm the payment in the Pollar popup…');

    let submittedHash = null;
    try {
      const sendResult = await Promise.race([
        sendPayment({
          destination: merchantAddress,
          amount: String(checkout.amount_xlm),
          asset: { type: 'native' },
          options: { memo: { type: 'text', value: String(checkout.payment_memo) } },
        }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('Pollar did not return a result within 90s. If you already confirmed, the payment may still go through — check transaction history before retrying.')),
          PAYMENT_TIMEOUT_MS
        )),
      ]);

      if (attemptId !== paymentAttemptRef.current) return;

      if (sendResult?.status === 'error') {
        throw new Error(sendResult.details || sendResult.message || sendResult.code || 'Pollar could not submit the payment.');
      }
      if (sendResult?.status === 'cosign_pending') {
        throw new Error('Wallet requires additional co-signing. Complete in Pollar, then retry.');
      }
      if (!sendResult?.hash) {
        throw new Error('Pollar did not return a transaction hash.');
      }

      submittedHash = sendResult.hash;
      setStatus(`Submitted: ${sendResult.hash.slice(0, 10)}… Verifying on Stellar…`);

      if (sendResult.status !== 'success') await waitForTransaction(sendResult.hash);
      if (attemptId !== paymentAttemptRef.current) return;

      setStatus('Verifying with FoodSub backend…');
      const verified = await verifyFoodSubOrder(checkout, sendResult.hash, walletAddress);
      if (attemptId !== paymentAttemptRef.current) return;

      setStatus(`✓ Payment verified for order #${checkout.order_id}. Closing…`);
      await pause(1500);
      if (attemptId !== paymentAttemptRef.current) return;
      setCheckout(null);
      setStatus('');
      window.dispatchEvent(new CustomEvent('foodsub:pollar:paid', { detail: { orderId: checkout.order_id, txHash: sendResult.hash } }));
      if (typeof window.foodSubToast === 'function') {
        window.foodSubToast(verified.message || 'Payment verified! Thank you 🎉');
      }
    } catch (err) {
      if (attemptId !== paymentAttemptRef.current) return;
      setError(err?.message || 'Payment failed. Check Pollar transaction history before retrying.');
      if (submittedHash) {
        setStatus(`Submitted but not confirmed yet. Hash: ${submittedHash.slice(0, 16)}…`);
      }
    } finally {
      if (attemptId === paymentAttemptRef.current) setBusy(false);
    }
  }

  function cancelPaymentWait() {
    paymentAttemptRef.current++;
    setBusy(false);
    setStatus('Stopped waiting. If you confirmed in Pollar, the payment may still complete — check transaction history and refresh your orders.');
  }

  async function handleLogout() {
    try { if (typeof logout === 'function') await logout(); } catch (e) { console.error('Logout failed', e); }
    paymentAttemptRef.current++;
    setCheckout(null);
    setStatus('');
    setError('');
    setBusy(false);
    setWalletBusy(false);
    createStarted.current = false;
  }

  function closeModal() {
    if (busy) {
      if (!window.confirm('A payment may be in progress. Close anyway? If you already confirmed in Pollar, check transaction history before retrying.')) return;
      paymentAttemptRef.current++;
      setBusy(false);
    }
    setCheckout(null);
    setStatus('');
    setError('');
  }

  if (!publishableKeyReady) {
    return <div className="pollar-nav-state" title="Set POLLAR_PUBLISHABLE_KEY">Pollar not configured</div>;
  }

  return (
    <>
      <button
        className={`pollar-nav-btn ${isAuthenticated ? 'connected' : ''}`}
        onClick={() => isAuthenticated ? openWalletBalanceModal() : openLoginModal()}
      >
        {isAuthenticated && walletAddress ? `Pollar · ${shortAddress(walletAddress)}` : isAuthenticated ? 'Pollar wallet' : 'Connect Pollar'}
      </button>

      {checkout && createPortal(
        <div className="pollar-overlay" role="dialog" aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="pollar-dialog">
            <button className="pollar-close" onClick={closeModal} aria-label="Close">×</button>
            <div className="pollar-label">FoodSub · Pollar checkout</div>
            <h2>Complete your order</h2>
            <p>Connect your Pollar wallet and approve a Stellar testnet payment.</p>

            <div className="pollar-meta">
              <div><span className="pollar-label">Order</span><br/><strong>#{checkout.order_id} · {checkout.package}</strong></div>
              <div style={{ marginTop: 12 }}><span className="pollar-label">FoodSub price</span><br/><strong>US$ {Number(checkout.amount_usd).toFixed(2)}</strong></div>
              <div style={{ marginTop: 12 }}><span className="pollar-label">Testnet payment amount</span><br/><strong>{checkout.amount_xlm} XLM</strong></div>
            </div>
            <p className="pollar-note">Demo rate: 1 USD = {config.demoXlmPerUsd || '1'} XLM. Testnet assets have no real value.</p>

            {!isAuthenticated ? (
              <button className="pollar-action" onClick={openLoginModal}>Connect / sign in with Pollar</button>
            ) : (
              <>
                <div className="pollar-address"><strong>Connected wallet</strong><br/>{walletAddress || (walletBusy ? 'Creating wallet…' : 'Wallet not ready')}</div>
                {walletBusy && <p>Preparing your Pollar wallet…</p>}
                {!walletReady && !walletBusy && hasWallet === false && (
                  <button className="pollar-secondary" onClick={retryWalletSetup}>Retry wallet setup</button>
                )}
                {walletReady && !busy && (
                  <button className="pollar-action" disabled={!merchantAddress} onClick={payWithPollar}>
                    Pay {checkout.amount_xlm} XLM with Pollar
                  </button>
                )}
                {walletReady && busy && (
                  <>
                    <button className="pollar-action" disabled>Processing payment…</button>
                    <button className="pollar-secondary" onClick={cancelPaymentWait}>Stop waiting (check tx history first)</button>
                  </>
                )}
                {!busy && (
                  <>
                    <button className="pollar-secondary" onClick={openTxHistoryModal}>View Pollar history</button>
                    <button className="pollar-secondary" onClick={handleLogout}>Disconnect Pollar</button>
                  </>
                )}
              </>
            )}

            {wallet && wallet.custody === 'smart' && (
              <div className="pollar-status pollar-error">Passkey smart wallets (C-addresses) not supported. Use email/social login.</div>
            )}
            {!merchantAddress && (
              <div className="pollar-status pollar-error">Merchant wallet not configured.</div>
            )}
            {status && <div className="pollar-status">{status}</div>}
            {error && <div className="pollar-status pollar-error">{error}</div>}
            {configStatus === 'error' && (
              <div className="pollar-status pollar-error">Pollar config error. Check dashboard app + allowed domain.</div>
            )}
            <p className="pollar-note">Network: {network || 'testnet'}. Payments verified on Stellar Horizon before order is marked paid.</p>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function App() {
  if (!config.pollarPublishableKey) {
    return <div className="pollar-nav-state">Pollar key missing</div>;
  }
  return (
    <PollarProvider client={{ apiKey: config.pollarPublishableKey, stellarNetwork: 'testnet' }}>
      <PollarExperience />
    </PollarProvider>
  );
}

const node = document.getElementById('pollar-root');
if (node) createRoot(node).render(<App />);