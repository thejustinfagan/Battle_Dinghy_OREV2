let connectedWallet = null;

async function connectWallet() {
  // Check for Phantom
  if (window.solana?.isPhantom) {
    try {
      const resp = await window.solana.connect();
      connectedWallet = {
        publicKey: resp.publicKey.toString(),
        signMessage: async (message) => {
          const encoded = new TextEncoder().encode(message);
          const signed = await window.solana.signMessage(encoded, 'utf8');
          return bs58Encode(signed.signature);
        },
      };
      return connectedWallet;
    } catch (err) {
      throw new Error('Wallet connection rejected');
    }
  }

  // Check for Solflare
  if (window.solflare?.isSolflare) {
    try {
      await window.solflare.connect();
      connectedWallet = {
        publicKey: window.solflare.publicKey.toString(),
        signMessage: async (message) => {
          const encoded = new TextEncoder().encode(message);
          const signed = await window.solflare.signMessage(encoded, 'utf8');
          return bs58Encode(signed.signature);
        },
      };
      return connectedWallet;
    } catch (err) {
      throw new Error('Wallet connection rejected');
    }
  }

  throw new Error('No Solana wallet found. Please install Phantom or Solflare.');
}

function getWallet() {
  return connectedWallet;
}

function disconnectWallet() {
  if (window.solana?.isPhantom) {
    window.solana.disconnect();
  }
  if (window.solflare?.isSolflare) {
    window.solflare.disconnect();
  }
  connectedWallet = null;
}

// Simple base58 encode for signatures
function bs58Encode(bytes) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  while (num > 0) {
    result = ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result;
    else break;
  }
  return result;
}
