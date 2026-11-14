import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { PollarProvider, usePollar } from '@pollar/react';
import '@pollar/react/styles.css';
import './pollar.css';

const config = window.FOODSUB_CONFIG || {};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  const merchantAddress = config.pollarMerchantAddress || '';
  const publishableKeyReady = Boolean(config.pollarPublishableKey);
  const walletAddress = wallet?.address || '';
  const walletReady = Boolean(walletAddress.startsWith('G')) && wallet?.existsOnStellar !== false && (!wallet?.provisioning || wallet.provisioning === 'READY');

  useEffect(() => {
    const openCheckout = (event) => {
      setCheckout(event.detail || null);
      setStatus('');
      setError('');
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
        .then(() => setStatus('Pollar wallet is being prepared. It may take a short moment to become ready.'))
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
      setStatus('Wallet setup requested. Wait until the address is ready before paying.');
    } catch (err) {
      setError(err?.message || 'Could not create your Pollar wallet.');
      setStatus('');
    } finally {
      setWalletBusy(false);
    }
  }

  async function waitForTransaction(hash) {
    const client = getClient();
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const result = await client.getTxStatus(hash);
      if (result?.status === 'SUCCESS') return;
      if (result?.status === 'FAILED') {
        throw new Error(`Stellar rejected the payment (${result.resultCode || 'transaction failed'}).`);
      }
      await pause(2500);
    }
    throw new Error('Payment was submitted but is still awaiting confirmation. Check transaction history before trying again.');
  }

  async function verifyFoodSubOrder(order, txHash, payerAddress) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const response = await fetch('/api/pollar/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: order.order_id, tx_hash: txHash, payer_address: payerAddress }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.paid) return result;
      if (response.status === 202 && result.pending) {
        setStatus('Transaction submitted. Waiting for Stellar testnet verification…');
        await pause(2000);
        continue;
      }
      throw new Error(result.error || result.message || 'FoodSub could not verify this payment.');
    }
    throw new Error('The transaction is not visible to Stellar Horizon yet. Do not pay again; check the transaction history and retry verification.');
  }

  async function payWithPollar() {
    setError('');
    if (!checkout) return;
    if (!merchantAddress) {
      setError('FoodSub receiving address is not configured. Add POLLAR_MERCHANT_ADDRESS to the server environment before accepting testnet payments.');
      return;
    }
    if (!walletAddress.startsWith('G')) {
      setError('This checkout supports classic Stellar G-address wallets. Sign in with email/social login or connect a classic Stellar wallet; passkey smart wallets (C-addresses) are not supported by this payment verifier yet.');
      return;
    }
    if (wallet?.existsOnStellar === false) {
      setError('Your Pollar wallet has not been activated on Stellar yet. Ask the app owner to use Immediate funding mode or fund this wallet in the Pollar Dashboard.');
      return;
    }
    if (!walletReady) {
      setError('Your Pollar wallet is not ready yet. Wait for wallet creation to finish.');
      return;
    }
    if (network !== 'testnet') {
      setError('This FoodSub build is configured for Stellar testnet only. Check the Pollar app network in its dashboard.');
      return;
    }

    setBusy(true);
    setStatus('Confirm the payment in Pollar…');
    try {
      const result = await sendPayment({
        destination: merchantAddress,
        amount: String(checkout.amount_xlm),
        asset: { type: 'native' },
        options: { memo: { type: 'text', value: String(checkout.payment_memo) } },
      });
      if (result?.status === 'error') {
        throw new Error(result.details || result.message || result.code || 'Pollar could not submit the payment.');
      }
      if (result?.status === 'cosign_pending') {
        throw new Error('This wallet requires an additional co-signing step. Complete it in Pollar, then retry only after checking transaction history.');
      }
      if (!result?.hash) {
        throw new Error('Pollar did not return a transaction hash. The order remains pending.');
      }

      setStatus('Waiting for transaction confirmation…');
      if (result.status !== 'success') await waitForTransaction(result.hash);
      const verified = await verifyFoodSubOrder(checkout, result.hash, walletAddress);
      setStatus(`Payment verified. FoodSub order #${checkout.order_id} is paid.`);
      setCheckout(null);
      window.dispatchEvent(new CustomEvent('foodsub:pollar:paid', { detail: { orderId: checkout.order_id, txHash: result.hash } }));
      if (typeof window.foodSubToast === 'function') window.foodSubToast(verified.message || 'Pollar payment verified. Thank you!');
    } catch (err) {
      setError(err?.message || 'Payment failed. Check Pollar transaction history before retrying.');
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  if (!publishableKeyReady) {
    return <div className="pollar-nav-state" title="Set POLLAR_PUBLISHABLE_KEY in .env">Pollar not configured</div>;
  }

  return (
    <>
      <button
        className={`pollar-nav-btn ${isAuthenticated ? 'connected' : ''}`}
        onClick={() => isAuthenticated ? openWalletBalanceModal() : openLoginModal()}
        title={isAuthenticated ? 'Open Pollar wallet' : 'Connect a Pollar wallet'}
      >
        {isAuthenticated && walletAddress ? `Pollar · ${shortAddress(walletAddress)}` : isAuthenticated ? 'Pollar wallet' : 'Connect Pollar'}
      </button>

      {checkout && createPortal(
        <div className="pollar-overlay" role="dialog" aria-modal="true" aria-label="Pollar checkout" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setCheckout(null); }}>
          <div className="pollar-dialog">
            <button className="pollar-close" onClick={() => !busy && setCheckout(null)} aria-label="Close">×</button>
            <div className="pollar-label">FoodSub · Pollar checkout</div>
            <h2>Complete your order</h2>
            <p>Connect your Pollar wallet and approve a Stellar testnet payment.</p>

            <div className="pollar-meta">
              <div><span className="pollar-label">Order</span><br/><strong>#{checkout.order_id} · {checkout.package}</strong></div>
              <div style={{ marginTop: 12 }}><span className="pollar-label">FoodSub price</span><br/><strong>US$ {Number(checkout.amount_usd).toFixed(2)}</strong></div>
              <div style={{ marginTop: 12 }}><span className="pollar-label">Testnet payment amount</span><br/><strong>{checkout.amount_xlm} XLM</strong></div>
            </div>
            <p className="pollar-note">Demo conversion: 1 USD = {config.demoXlmPerUsd || '1'} XLM. XLM on testnet has no real-world monetary value. This is not a live exchange-rate quote.</p>

            {!isAuthenticated ? (
              <button className="pollar-action" onClick={openLoginModal}>Connect / sign in with Pollar</button>
            ) : (
              <>
                <div className="pollar-address"><strong>Connected wallet</strong><br/>{walletAddress || (walletBusy ? 'Creating wallet…' : 'Wallet is not ready')}</div>
                {walletBusy && <p>Preparing your Pollar wallet…</p>}
                {!walletReady && !walletBusy && hasWallet === false && <button className="pollar-secondary" onClick={retryWalletSetup}>Retry wallet setup</button>}
                {walletAddress && !walletAddress.startsWith('G') && <div className="pollar-status pollar-error">This demo checkout requires a classic Stellar G-address. A passkey smart wallet uses a C-address and is not supported by the current payment verifier.</div>}
                {wallet?.existsOnStellar === false && <div className="pollar-status pollar-error">This wallet is not yet active on Stellar. Set Pollar Funding Mode to Immediate or fund the wallet in the Pollar Dashboard.</div>}
                {walletReady && (
                  <button className="pollar-action" disabled={busy || !merchantAddress} onClick={payWithPollar}>
                    {busy ? 'Processing payment…' : `Pay ${checkout.amount_xlm} XLM with Pollar`}
                  </button>
                )}
                <button className="pollar-secondary" disabled={busy} onClick={openTxHistoryModal}>View Pollar transaction history</button>
                <button className="pollar-secondary" disabled={busy} onClick={logout}>Disconnect Pollar</button>
              </>
            )}

            {wallet && wallet.custody === 'smart' && <div className="pollar-status pollar-error">Passkey smart wallets use C-addresses and are not supported by this native-XLM checkout verifier. Use email/social login or a classic Stellar G-address wallet for this demo.</div>}
            {!merchantAddress && <div className="pollar-status pollar-error">FoodSub's receiving wallet has not been configured yet. Set POLLAR_MERCHANT_ADDRESS in the server environment.</div>}
            {status && <div className="pollar-status">{status}</div>}
            {error && <div className="pollar-status pollar-error">{error}</div>}
            {configStatus === 'error' && <div className="pollar-status pollar-error">Pollar configuration could not be loaded. Check the Pollar dashboard app, network and allowed domain.</div>}
            <p className="pollar-note">Network: {network || config.pollarNetwork || 'testnet'}. Payments are verified against Stellar Horizon before FoodSub marks the order as paid.</p>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function App() {
  if (!config.pollarPublishableKey) {
    return <div className="pollar-nav-state" title="Add Pollar publishable key to the server environment">Pollar key missing</div>;
  }
  return (
    <PollarProvider client={{ apiKey: config.pollarPublishableKey, stellarNetwork: 'testnet' }}>
      <PollarExperience />
    </PollarProvider>
  );
}

const node = document.getElementById('pollar-root');
if (node) createRoot(node).render(<App />);