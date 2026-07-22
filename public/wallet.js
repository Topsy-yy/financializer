/* ═══════════════════════════════════════════════════════════════
   FinGuard AI — Wallet Connect (EIP-1193 + Avalanche helpers)
   Real browser-wallet connection: Core Wallet / MetaMask / any
   injected provider. The user's own wallet signs everything —
   sign-in messages and contract deployments alike.
   ═══════════════════════════════════════════════════════════════ */

var FinGuardWallet = (function () {
  var state = {
    address: null,
    chainId: null,
    verified: false,
    provider: null,
    browserProvider: null
  };

  var listeners = [];

  function onChange(cb) {
    listeners.push(cb);
  }

  function emitChange() {
    listeners.forEach(function (cb) {
      try { cb(getState()); } catch (e) { /* ignore listener errors */ }
    });
  }

  function detectProvider() {
    if (window.avalanche) return window.avalanche;
    if (window.ethereum) return window.ethereum;
    return null;
  }

  function detectProviderLabel() {
    if (window.avalanche) return "Core Wallet";
    if (window.ethereum) return "MetaMask (or compatible)";
    return null;
  }

  function hasWalletExtension() {
    return Boolean(detectProvider());
  }

  function bindProviderEvents(injected) {
    if (injected.__finguardBound || typeof injected.on !== "function") return;
    injected.__finguardBound = true;
    injected.on("accountsChanged", function (accounts) {
      state.address = accounts && accounts[0] ? accounts[0] : null;
      state.verified = false;
      if (!state.address) {
        state.browserProvider = null;
        state.provider = null;
      }
      emitChange();
    });
    injected.on("chainChanged", function (chainIdHex) {
      state.chainId = parseInt(chainIdHex, 16);
      state.verified = false;
      emitChange();
    });
  }

  async function connect() {
    var injected = detectProvider();
    if (!injected) {
      var err = new Error("No wallet extension found. Install Core Wallet or MetaMask to continue.");
      err.code = "no_provider";
      throw err;
    }

    var accounts = await injected.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) throw new Error("No account was returned by the wallet.");

    state.provider = injected;
    state.browserProvider = new ethers.BrowserProvider(injected);
    state.address = accounts[0];
    var chainIdHex = await injected.request({ method: "eth_chainId" });
    state.chainId = parseInt(chainIdHex, 16);
    state.verified = false;

    bindProviderEvents(injected);
    emitChange();
    return getState();
  }

  async function silentReconnect() {
    var injected = detectProvider();
    if (!injected) return null;

    try {
      var accounts = await injected.request({ method: "eth_accounts" });
      if (!accounts || !accounts.length) return null;

      state.provider = injected;
      state.browserProvider = new ethers.BrowserProvider(injected);
      state.address = accounts[0];
      var chainIdHex = await injected.request({ method: "eth_chainId" });
      state.chainId = parseInt(chainIdHex, 16);

      bindProviderEvents(injected);
      emitChange();
      return getState();
    } catch (e) {
      return null;
    }
  }

  async function signIn() {
    if (!state.address || !state.browserProvider) throw new Error("Connect a wallet first.");

    var res = await fetch("/api/wallet/nonce?address=" + encodeURIComponent(state.address));
    var data = await res.json();
    if (!data.ok) throw new Error("Could not get a sign-in message from the server.");

    var signer = await state.browserProvider.getSigner();
    var signature = await signer.signMessage(data.message);

    var verifyRes = await fetch("/api/wallet/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: state.address, signature: signature, chainId: state.chainId })
    });
    var verifyData = await verifyRes.json();
    if (!verifyRes.ok || !verifyData.ok) throw new Error("Signature verification failed.");

    state.verified = true;
    emitChange();
    return true;
  }

  async function switchNetwork(network) {
    if (!state.provider) throw new Error("Connect a wallet first.");

    try {
      await state.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: network.chainIdHex }]
      });
    } catch (switchError) {
      if (switchError && (switchError.code === 4902 || switchError.code === -32603)) {
        await state.provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: network.chainIdHex,
            chainName: network.name,
            nativeCurrency: network.nativeCurrency,
            rpcUrls: [network.rpcUrl],
            blockExplorerUrls: network.explorerUrl ? [network.explorerUrl] : []
          }]
        });
      } else {
        throw switchError;
      }
    }

    var chainIdHex = await state.provider.request({ method: "eth_chainId" });
    state.chainId = parseInt(chainIdHex, 16);
    emitChange();
  }

  async function getBalance() {
    if (!state.browserProvider || !state.address) return null;
    var raw = await state.browserProvider.getBalance(state.address);
    return ethers.formatEther(raw);
  }

  async function deployTemplate(template, constructorArgs) {
    if (!state.browserProvider || !state.address) throw new Error("Connect a wallet first.");
    var signer = await state.browserProvider.getSigner();
    var factory = new ethers.ContractFactory(template.abi, template.bytecode, signer);
    var contract = await factory.deploy.apply(factory, constructorArgs || []);
    var deployTx = contract.deploymentTransaction();

    return {
      txHash: deployTx.hash,
      wait: async function () {
        var receipt = await deployTx.wait();
        var address = await contract.getAddress();
        return { address: address, receipt: receipt };
      }
    };
  }

  function trustServerVerification(expectedAddress) {
    if (!state.address || !expectedAddress) return false;
    if (state.address.toLowerCase() !== String(expectedAddress).toLowerCase()) return false;
    state.verified = true;
    emitChange();
    return true;
  }

  function disconnect() {
    state.address = null;
    state.chainId = null;
    state.verified = false;
    state.browserProvider = null;
    state.provider = null;
    emitChange();
  }

  function getState() {
    return {
      address: state.address,
      chainId: state.chainId,
      verified: state.verified,
      providerLabel: detectProviderLabel()
    };
  }

  return {
    hasWalletExtension: hasWalletExtension,
    detectProviderLabel: detectProviderLabel,
    connect: connect,
    silentReconnect: silentReconnect,
    signIn: signIn,
    switchNetwork: switchNetwork,
    getBalance: getBalance,
    deployTemplate: deployTemplate,
    disconnect: disconnect,
    trustServerVerification: trustServerVerification,
    getState: getState,
    onChange: onChange
  };
})();
