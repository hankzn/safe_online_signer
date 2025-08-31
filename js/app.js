// js/app.js
(function(){
  const $ = (id)=> document.getElementById(id);
  const byName = (name)=> document.querySelector(`[name="${name}"]:checked`);
  const ZERO = "0x0000000000000000000000000000000000000000";

  const { ethers } = window;
  const IF_SAFE = new ethers.Interface(window.AppABIs.SAFE_ABI);
  const IF_ERC20 = new ethers.Interface(window.AppABIs.ERC20_ABI);

  let gChainId=null, gProvider=null, gSafe=null, gOwners=[], gThreshold=0, gNonce=0;
  let gDomain=null, gTypes=null, gMessage=null, gHash=null, gSigs=[];
  let gGasChoice=null;

  // tx_human.json（pretty 与 compact）
  let gSubmitJSONText="";
  let gSubmitJSONCompact="";

  async function rpc(url, method, params=[]){
    const body = JSON.stringify({ jsonrpc:"2.0", id:Date.now(), method, params });
    const r = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.result;
  }
  function requireRPCs(){
    const u1=$("rpc1").value.trim(), u2=$("rpc2").value.trim();
    if(!u1||!u2) throw new Error("请先填写两条 RPC");
    return [u1,u2];
  }

  function switchKind(){
    const k=byName("kind").value;
    $("eth_box").classList.toggle("hidden", k!=="ETH");
    $("erc_box").classList.toggle("hidden", k!=="ERC20");
  }
  Array.from(document.getElementsByName("kind")).forEach(r=> r.addEventListener("change", switchKind));
  switchKind();

  // 摄像头扫码（签名）
  let scanStream=null, rafId=null;
  async function openCamera(videoEl){
    const constraints={ audio:false, video:{ facingMode:{ideal:"environment"}, width:{ideal:1920}, height:{ideal:1080}, aspectRatio:{ideal:16/9} } };
    const stream=await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject=stream; await videoEl.play(); return stream;
  }
  function prepSquareFrame(videoEl, canvasEl){
    const vw=videoEl.videoWidth||1280, vh=videoEl.videoHeight||720;
    const s=Math.min(vw,vh), sx=(vw-s)/2, sy=(vh-s)/2;
    const size=800; canvasEl.width=size; canvasEl.height=size;
    return {sx,sy,s,dx:0,dy:0,w:size,h:size};
  }
  function stopScan(){
    if(rafId) { cancelAnimationFrame(rafId); rafId=null; }
    if(scanStream){ scanStream.getTracks().forEach(t=>t.stop()); scanStream=null; }
    $("video").srcObject=null; $("cam_box").style.display="none";
  }

  // Safe 基本信息
  $("btn_load").onclick=async ()=>{
    try{
      const [u1] = requireRPCs();
      const addr = $("safe_addr").value.trim();
      if(!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error("Safe 地址不合法");

      gProvider = new ethers.JsonRpcProvider(u1);
      const chainIdHex = await rpc(u1, "eth_chainId", []);
      gChainId = parseInt(chainIdHex, 16);

      gSafe = new ethers.Contract(addr, window.AppABIs.SAFE_ABI, gProvider);
      gOwners = await gSafe.getOwners();
      gThreshold = Number(await gSafe.getThreshold());
      gNonce = Number(await gSafe.nonce());
      $("nonce").value = gNonce;

      $("net_status").textContent = "读取成功";
      $("safe_info").textContent = `chainId=${gChainId}
owners=${JSON.stringify(gOwners,null,2)}
threshold=${gThreshold}
nonce=${gNonce}`;
    }catch(e){
      $("net_status").textContent = "错误："+e.message;
      $("safe_info").textContent = "";
    }
  };

  $("btn_refresh_nonce").onclick=async ()=>{
    try{
      if(!gSafe) throw new Error("请先读取 Safe 信息");
      gNonce=Number(await gSafe.nonce());
      $("nonce").value=gNonce;
      $("build_status").textContent="已刷新 nonce="+gNonce;
    }catch(e){ $("build_status").textContent="错误："+e.message; }
  };

  // 构造调用 & 估算
  function decimalToSmallestStr(amountStr,decimals){
    if(!/^\d+(\.\d+)?$/.test(amountStr)) throw new Error("金额格式应为非负小数");
    const [i,f=""]=amountStr.split(".");
    if(f.length>decimals) throw new Error("小数位超过 decimals");
    const s=(i+f.padEnd(decimals,"0")).replace(/^0+/,"")||"0";
    BigInt(s);
    return s;
  }
  function buildCall(){
    const k=byName("kind").value;
    if(k==="ETH"){
      const to=$("eth_to").value.trim();
      const amt=$("eth_amount").value.trim();
      if(!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("ETH 收款地址不合法");
      const valueWei = ethers.parseUnits(amt||"0","ether");
      return { to, value:valueWei, data:"0x" };
    }else{
      const token=$("erc_token").value.trim();
      const to=$("erc_to").value.trim();
      const amtH=$("erc_amount").value.trim();
      const dec=Number($("erc_decimals").value||"18");
      if(!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("Token 地址不合法");
      if(!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("收款地址不合法");
      const small=decimalToSmallestStr(amtH||"0",dec);
      const data=IF_ERC20.encodeFunctionData("transfer",[to, small]);
      return { to:token, value:0n, data };
    }
  }
  $("btn_estimate").onclick=async ()=>{
    try{
      if(!gSafe) throw new Error("请先读取 Safe 信息");
      const [u1]=requireRPCs();
      const call=buildCall();
      const tx={ from:gSafe.target, to:call.to, data:call.data, value:"0x"+BigInt(call.value||0n).toString(16) };
      const gasHex=await rpc(u1,"eth_estimateGas",[tx]);
      const gas=parseInt(gasHex,16);
      const withBuf=Math.ceil(gas*1.1);
      $("safeTxGas").value=withBuf;
      $("build_status").textContent=`estimateGas: ${gas} → +10% = ${withBuf}`;
    }catch(e){ $("build_status").textContent="错误："+e.message; }
  };

  // 生成 EIP-712
  $("btn_build_712").onclick=()=>{
    try{
      if(!gSafe) throw new Error("请先读取 Safe 信息");
      const call=buildCall();
      const op=Number($("op").value||"0");
      const safeTxGas=Number($("safeTxGas").value||"0");
      const baseGas=Number($("baseGas").value||"0");
      const gasPrice=Number($("gasPrice").value||"0");
      const gasToken=$("gasToken").value.trim()||ZERO;
      const refundReceiver=$("refundReceiver").value.trim()||ZERO;
      const nonce=Number($("nonce").value||"0");

      const domain={ verifyingContract:gSafe.target, chainId:gChainId };
      const types={ SafeTx:[
        {name:"to",type:"address"},
        {name:"value",type:"uint256"},
        {name:"data",type:"bytes"},
        {name:"operation",type:"uint8"},
        {name:"safeTxGas",type:"uint256"},
        {name:"baseGas",type:"uint256"},
        {name:"gasPrice",type:"uint256"},
        {name:"gasToken",type:"address"},
        {name:"refundReceiver",type:"address"},
        {name:"nonce",type:"uint256"},
      ]};
      const message={
        to:call.to,
        value:call.value.toString(),
        data:call.data,
        operation:op,
        safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce
      };
      const typed={ domain, types, message, primaryType:"SafeTx" };

      $("typed_json").value=JSON.stringify(typed,null,2);
      const hash=ethers.TypedDataEncoder.hash(domain,types,message);
      $("typed_hash").value=hash;

      const div=$("qr_typed"); div.innerHTML="";
      new QRCode(div,{text:JSON.stringify(typed),width:240,height:240,colorDark:"#000",colorLight:"#fff",correctLevel:QRCode.CorrectLevel.M});

      $("build_status").textContent="已生成 EIP-712 JSON 与 safeTxHash";
      gDomain=domain; gTypes=types; gMessage=message; gHash=hash; gSigs=[]; renderSigs();
    }catch(e){ $("build_status").textContent="错误："+e.message; }
  };

  // 签名收集
  $("btn_scan_sig").onclick=async ()=>{
    $("cam_box").style.display="";
    $("scan_status").textContent="启动摄像头…";
    try{
      const video=$("video"), canvas=$("canvas");
      scanStream=await openCamera(video);
      $("scan_status").textContent="请将二维码置于白色框内";
      const ctx=canvas.getContext("2d");
      const tick=()=>{
        if(!video.videoWidth){ rafId=requestAnimationFrame(tick); return; }
        const {sx,sy,s,dx,dy,w,h}=prepSquareFrame(video,canvas);
        ctx.drawImage(video, sx,sy,s,s, dx,dy,w,h);
        const img=ctx.getImageData(0,0,w,h);
        const code=jsQR(img.data,w,h,{inversionAttempts:"attemptBoth"});
        if(code && code.data){
          const t=code.data.trim();
          if(/^0x[0-9a-fA-F]+$/.test(t) && t.length>130){
            stopScan(); addSigHex(t); return;
          }
        }
        rafId=requestAnimationFrame(tick);
      };
      tick();
    }catch(e){ $("scan_status").textContent="摄像头失败："+e.message; }
  };
  $("stop_scan").onclick=stopScan;

  $("btn_add_sig").onclick=()=> addSigHex(($("sig_hex").value||"").trim());

  function renderSigs(){
    const rows=gSigs.map((s,i)=>`<tr><td>${i+1}</td><td class="mono">${s.signer}</td><td class="mono">${s.sig.slice(0,18)}…</td></tr>`).join("");
    $("sigs_table_box").innerHTML = `<div class="muted">已收集 ${gSigs.length} / 阈值 ${gThreshold}</div>
      <table><tr><th>#</th><th>signer</th><th>sig</th></tr>${rows}</table>`;
  }
  async function addSigHex(sigHex){
    try{
      if(!gHash||!gDomain) throw new Error("请先生成 EIP-712 JSON");
      if(!/^0x[0-9a-fA-F]+$/.test(sigHex) || sigHex.length<130) throw new Error("签名格式不正确");
      const signer=ethers.getAddress(ethers.verifyTypedData(gDomain,gTypes,gMessage,sigHex));
      gSigs.push({signer, sig:sigHex});
      const map=new Map(); gSigs.forEach(x=> map.set(x.signer.toLowerCase(), x));
      gSigs=Array.from(map.values());

      $("sig_status").textContent = (gOwners.length && !gOwners.map(a=>a.toLowerCase()).includes(signer.toLowerCase()))
        ? "警告：签名人不在 owners 列表"
        : (gSigs.length>=gThreshold ? "已达阈值" : "已添加");
      renderSigs();
    }catch(e){ $("sig_status").textContent="错误："+e.message; }
  }

  function packSignatures(list){
    const sorted=list.slice().sort((a,b)=> a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1);
    let packed="0x";
    for(const s of sorted){
      const sig=ethers.Signature.from(s.sig);
      const r=sig.r.replace(/^0x/,'').padStart(64,'0');
      const S=sig.s.replace(/^0x/,'').padStart(64,'0');
      let v=Number(sig.v); if(v===0||v===1) v+=27;
      packed+= r + S + v.toString(16).padStart(2,'0');
    }
    return packed;
  }
  $("btn_assemble").onclick=()=>{
    try{
      if(!gSafe||!gMessage) throw new Error("缺少 Safe 或 EIP-712 消息");
      if(gSigs.length<gThreshold) throw new Error(`签名不足：${gSigs.length}/${gThreshold}`);
      const signatures=packSignatures(gSigs);
      const data=IF_SAFE.encodeFunctionData("execTransaction",[
        gMessage.to, gMessage.value, gMessage.data, gMessage.operation,
        gMessage.safeTxGas, gMessage.baseGas, gMessage.gasPrice, gMessage.gasToken,
        gMessage.refundReceiver, signatures
      ]);
      $("calldata").value=data;
      $("asm_status").textContent="已编码 calldata";
    }catch(e){ $("asm_status").textContent="错误："+e.message; }
  };

  // Gas 档位
  function toGwei(n){ return Number(ethers.formatUnits(n, "gwei")); }
  async function getGasTiers(){
    if(!gProvider){
      const [u1] = requireRPCs();
      gProvider = new ethers.JsonRpcProvider(u1);
    }
    try{
      const BLOCKS=30, PCTS=[25,50,90];
      const hist = await gProvider.send("eth_feeHistory", [ "0x"+BLOCKS.toString(16), "latest", PCTS ]);
      const baseFeeWei = BigInt(hist.baseFeePerGas[hist.baseFeePerGas.length-1]);
      function median(arr){ const a=[...arr].map(BigInt).sort((x,y)=> x<y?-1:1); const m=Math.floor(a.length/2); return (a.length%2)? a[m] : ((a[m-1]+a[m])/2n); }
      const tips=[0,1,2].map(i=> median(hist.reward.map(row=> row[i])));
      const base=toGwei(baseFeeWei), p25=toGwei(tips[0]), p50=toGwei(tips[1]), p90=toGwei(tips[2]);
      return {
        low:  { tier:"低",  baseFee_gwei:base, priority_gwei:p25, maxFee_gwei: base*1.10 + p25 },
        mid:  { tier:"中",  baseFee_gwei:base, priority_gwei:p50, maxFee_gwei: base*1.25 + p50 },
        high: { tier:"高",  baseFee_gwei:base, priority_gwei:p90, maxFee_gwei: base*1.50 + p90 },
      };
    }catch(e){
      const [block, tipHex] = await Promise.all([ gProvider.getBlock("latest"), gProvider.send("eth_maxPriorityFeePerGas", []) ]);
      if(!block || block.baseFeePerGas==null) throw new Error("无法获取 baseFeePerGas");
      const base=toGwei(block.baseFeePerGas), tip=Number(ethers.formatUnits(tipHex, "gwei"));
      return {
        low:  { tier:"低",  baseFee_gwei:base, priority_gwei:Math.max(0.5, tip*0.5), maxFee_gwei: base*1.10 + Math.max(0.5, tip*0.5) },
        mid:  { tier:"中",  baseFee_gwei:base, priority_gwei:tip,                 maxFee_gwei: base*1.25 + tip },
        high: { tier:"高",  baseFee_gwei:base, priority_gwei:tip*1.5,             maxFee_gwei: base*1.50 + tip*1.5 },
      };
    }
  }
  $("btn_gas_est").onclick = async ()=>{
    try{
      const tiers=await getGasTiers();
      const rows=[tiers.low,tiers.mid,tiers.high].map(t=>{
        const bf=t.baseFee_gwei.toFixed(2), pr=t.priority_gwei.toFixed(2), mf=t.maxFee_gwei.toFixed(2);
        return `<tr>
          <td>${t.tier}</td>
          <td>${bf}</td>
          <td>${pr}</td>
          <td>${mf}</td>
          <td><button class="ghost btn_apply" data-tier="${t.tier}" data-pr="${pr}" data-mf="${mf}">应用</button></td>
        </tr>`;
      }).join("");
      $("gas_table_box").innerHTML=`<table>
        <tr><th>档位</th><th>Base(gwei, 近块)</th><th>Priority(gwei, pct)</th><th>MaxFee(gwei)</th><th>操作</th></tr>
        ${rows}
      </table>
      <div class="muted">说明：MaxFee ≈ Base×(1.10/1.25/1.50) + Priority；“应用”后用于生成提交者 tx_human.json。</div>`;
      $("gas_status").textContent="完成";

      Array.from(document.getElementsByClassName("btn_apply")).forEach(btn=>{
        btn.onclick = ()=>{
          const tier=btn.getAttribute("data-tier");
          const pr=Number(btn.getAttribute("data-pr"));
          const mf=Number(btn.getAttribute("data-mf"));
          gGasChoice = { tier, priority_gwei:pr, maxFee_gwei:mf };
          $("gas_choice").textContent = `${tier}（max≈${mf} gwei / tip≈${pr} gwei）`;
          $("gas_applied").classList.remove("hidden");
        };
      });
    }catch(e){
      $("gas_status").textContent="错误："+e.message;
      $("gas_table_box").innerHTML="";
      $("gas_applied").classList.add("hidden");
      gGasChoice=null;
    }
  };

  // ===== SAFEQR 动态二维码（循环播放） =====
  async function sha256Hex(str){
    const bytes = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
  }
  function splitFrames(text, maxLen){
    const frames=[]; for(let i=0;i<text.length;i+=maxLen){ frames.push(text.slice(i,i+maxLen)); } return frames;
  }

  let QR_FRAMES=[], QR_IDX=0, QR_TIMER=null;
  function stopQRPlay(){ if(QR_TIMER){ clearInterval(QR_TIMER); QR_TIMER=null; } }
  function renderQRFrame(){
    const div=$("qr_submit"); div.innerHTML="";
    if(!QR_FRAMES.length){ $("qr_nav").classList.add("hidden"); $("qr_info").textContent="0 / 0"; return; }
    new QRCode(div,{text:QR_FRAMES[QR_IDX],width:260,height:260,colorDark:"#000",colorLight:"#fff",correctLevel:QRCode.CorrectLevel.M});
    $("qr_info").textContent = `${QR_IDX+1} / ${QR_FRAMES.length}`;
    $("qr_nav").classList.remove("hidden");
  }
  function getQRSettings(){
    const chunk = Math.max(200, Math.min(2000, Number($("qr_chunk").value) || 900));
    const gap   = Math.max(200, Number($("qr_interval").value) || 700);
    return {chunk, gap};
  }
  function startQRLoop(gap){
    stopQRPlay();
    if(!QR_FRAMES.length) return;
    QR_TIMER = setInterval(()=>{
      if(!QR_FRAMES.length) return;
      QR_IDX = (QR_IDX + 1) % QR_FRAMES.length;
      renderQRFrame();
    }, gap);
    $("qr_pause").classList.remove("hidden");
    $("qr_play").classList.add("hidden");
  }

  $("qr_prev").onclick=()=>{ if(!QR_FRAMES.length) return; stopQRPlay(); QR_IDX=(QR_IDX-1+QR_FRAMES.length)%QR_FRAMES.length; renderQRFrame(); $("qr_pause").classList.add("hidden"); $("qr_play").classList.remove("hidden"); };
  $("qr_next").onclick=()=>{ if(!QR_FRAMES.length) return; stopQRPlay(); QR_IDX=(QR_IDX+1)%QR_FRAMES.length; renderQRFrame(); $("qr_pause").classList.add("hidden"); $("qr_play").classList.remove("hidden"); };
  $("qr_pause").onclick=()=>{ stopQRPlay(); $("qr_pause").classList.add("hidden"); $("qr_play").classList.remove("hidden"); };
  $("qr_play").onclick =()=>{ if(!QR_FRAMES.length || QR_TIMER) return; const {gap}=getQRSettings(); startQRLoop(gap); };

  $("btn_copy_qr_one").onclick = async ()=>{
    if(!QR_FRAMES.length) return;
    try{ await navigator.clipboard.writeText(QR_FRAMES[QR_IDX]); $("submit_status").textContent = "已复制当前帧"; }
    catch(e){ $("submit_status").textContent = "复制失败："+(e.message||e); }
  };
  $("btn_copy_qr_all").onclick = async ()=>{
    if(!QR_FRAMES.length) { $("submit_status").textContent = "还没有生成帧"; return; }
    try{ await navigator.clipboard.writeText(QR_FRAMES.join("\n")); $("submit_status").textContent = `已复制全部 ${QR_FRAMES.length} 帧`; }
    catch(e){ $("submit_status").textContent = "复制失败："+(e.message||e); }
  };

  async function buildSafeQRFramesFromText(text, chunk){
    const fullHash = await sha256Hex(text);
    const sessionId = fullHash.slice(0,16);
    const parts = (text.length<=chunk) ? [text] : splitFrames(text, chunk);
    const n = parts.length;
    return {
      id: sessionId,
      frames: parts.map((data,i)=> JSON.stringify({ t:"SAFEQR", v:1, id:sessionId, i, n, sum:sessionId, data }))
    };
  }

  // ===== ① 从 calldata 生成 tx_human.json（查询 nonce + 估算 gas + 压缩 data_hex） =====
  async function buildTxHumanJsonFromCalldata() {
    const calldataRaw = ($("calldata").value || "").trim();
    if (!calldataRaw) throw new Error("请先生成并填写 calldata（上方“聚合并编码”）");

    // 压缩 calldata 表示
    let cleanData = calldataRaw;
    try {
      cleanData = ethers.hexlify(ethers.getBytes(calldataRaw));
    } catch (e) {
      cleanData = calldataRaw; // 不可解析则保留原值
    }

    // 读取提交者 EOA
    const sender = ($("sender_eoa").value || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(sender)) {
      throw new Error("请填写有效的“提交者 EOA 地址”");
    }

    // 选取 Safe 地址：优先 gSafe.target；若未加载，用输入框 safe_addr
    let safeTo = gSafe?.target;
    if (!safeTo) {
      const inputSafe = ($("safe_addr").value || "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(inputSafe)) {
        throw new Error("未读取 Safe 信息，且 Safe 地址输入不合法");
      }
      safeTo = inputSafe;
    }

    // 确认 RPC / chainId
    const [u1] = requireRPCs();
    if (!gChainId) {
      const chainIdHex = await rpc(u1, "eth_chainId", []);
      gChainId = parseInt(chainIdHex, 16);
    }

    // 1) 查询 pending nonce
    const nonceHex = await rpc(u1, "eth_getTransactionCount", [sender, "pending"]);
    const nonceDec = parseInt(nonceHex, 16);

    // 2) 估算“外层提交交易”的 gas（from=EOA → to=Safe，data=cleanData）
    const estimateTx = {
      from: sender,
      to: safeTo,
      data: cleanData,
      value: "0x0"
    };
    let gasEstDec = 0;
    try {
      const gasHex = await rpc(u1, "eth_estimateGas", [estimateTx]);
      gasEstDec = Math.ceil(parseInt(gasHex, 16) * 1.10); // +10% buffer
    } catch (e) {
      gasEstDec = 21000; // 回退
    }

    // 3) gas 价格：若已选择档位则用之；否则取“中”
    let maxFeePerGas_gwei, maxPriorityFeePerGas_gwei;
    if (gGasChoice) {
      maxFeePerGas_gwei = Number(gGasChoice.maxFee_gwei);
      maxPriorityFeePerGas_gwei = Number(gGasChoice.priority_gwei);
    } else {
      const tiers = await getGasTiers();
      maxFeePerGas_gwei = Number(tiers.mid.maxFee_gwei.toFixed(2));
      maxPriorityFeePerGas_gwei = Number(tiers.mid.priority_gwei.toFixed(2));
    }

    // 4) 组装 tx_human.json（已压缩的 data_hex）
    const h = {
      kind: "ETH",
      from: sender,
      to: safeTo,
      value_wei: 0,
      amount_eth: "0",
      data_hex: cleanData,
      chainId: gChainId,
      nonce: nonceDec,                 // ✅ pending nonce
      gas: gasEstDec,                  // ✅ 估算 gas (+10%)
      maxFeePerGas_gwei,               // ✅ 数值
      maxPriorityFeePerGas_gwei        // ✅ 数值
    };

    const compact = JSON.stringify(h);
    const pretty  = JSON.stringify(h, null, 2);
    return { compact, pretty };
  }

  $("btn_build_json").onclick = async ()=>{
    try{
      const {compact, pretty} = await buildTxHumanJsonFromCalldata();
      gSubmitJSONCompact = compact;
      gSubmitJSONText    = pretty;
      $("submit_status").textContent = "已生成 tx_human.json（已填 nonce / gas / gasPrice，并压缩 data_hex），可复制/下载，或执行步骤②生成 SAFEQR";
    }catch(e){ $("submit_status").textContent = "错误："+(e.message||e); }
  };

  // ===== ② 从 tx_human.json 生成 SAFEQR（循环播放） =====
  $("btn_make_safeqr").onclick = async ()=>{
    try{
      if(!gSubmitJSONCompact){
        const {compact, pretty} = await buildTxHumanJsonFromCalldata();
        gSubmitJSONCompact = compact;
        gSubmitJSONText = pretty;
      }
      const {chunk, gap} = getQRSettings();
      const built = await buildSafeQRFramesFromText(gSubmitJSONCompact, chunk);
      QR_FRAMES = built.frames;
      QR_IDX = 0;
      renderQRFrame();
      startQRLoop(gap);
      $("submit_status").textContent = `已从 tx_human.json 生成 ${QR_FRAMES.length} 帧 SAFEQR（循环播放中），id=${built.id}`;
    }catch(e){ $("submit_status").textContent = "错误："+(e.message||e); }
  };

  // 复制 & 下载 tx_human.json（必要时自动先构建一次）
  $("btn_copy_json").onclick = async ()=>{
    try{
      if(!gSubmitJSONText){ const {pretty} = await buildTxHumanJsonFromCalldata(); gSubmitJSONText = pretty; }
      await navigator.clipboard.writeText(gSubmitJSONText);
      $("submit_status").textContent = "已复制 JSON 到剪贴板";
    }catch(e){ $("submit_status").textContent = "复制失败："+e.message; }
  };
  $("btn_download_json").onclick = async ()=>{
    try{
      if(!gSubmitJSONText){ const {pretty} = await buildTxHumanJsonFromCalldata(); gSubmitJSONText = pretty; }
      const blob = new Blob([gSubmitJSONText], {type:"application/json"});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "tx_human.json";
      document.body.appendChild(a); a.click(); a.remove();
      $("submit_status").textContent = "已下载 tx_human.json";
    }catch(e){ $("submit_status").textContent = "下载失败："+e.message; }
  };

  // 广播 / Nonce / 浏览器
  $("btn_broadcast").onclick=async ()=>{
    try{
      const [u1,u2]=requireRPCs();
      const raw=($("rawtx").value||"").trim();
      if(!/^0x[0-9a-fA-F]+$/.test(raw)||raw.length<=100) throw new Error("RawTx 格式不正确");
      const txhash=ethers.keccak256(raw);
      $("bc_status").textContent="本地 txhash："+txhash;
      const urls=[u1,u2],names=["RPC_1","RPC_2"];
      const results=await Promise.allSettled(urls.map(u=> rpc(u,"eth_sendRawTransaction",[raw])));
      const rows=results.map((r,i)=> r.status==="fulfilled"
        ? `<tr><td>${names[i]}</td><td class="ok">OK</td><td class="mono">${r.value}</td></tr>`
        : `<tr><td>${names[i]}</td><td class="bad">FAIL</td><td class="mono">${(r.reason&&r.reason.message)||String(r.reason)}</td></tr>`
      ).join("");
      $("bc_table_box").innerHTML=`<table><tr><th>RPC</th><th>结果</th><th>响应/错误</th></tr>${rows}</table>`;
    }catch(e){ $("bc_status").textContent="错误："+e.message; $("bc_table_box").innerHTML=""; }
  };

  $("btn_get_nonce").onclick=async ()=>{
    const box=$("nonce_table_box");
    try{
      const [u1,u2]=requireRPCs();
      const a=($("addr").value||"").trim();
      if(!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("地址不合法");
      const urls=[u1,u2],names=["RPC_1","RPC_2"];
      const results=await Promise.allSettled(urls.map(async u=>{
        const hex=await rpc(u,"eth_getTransactionCount",[a,"pending"]);
        return {hex,dec:parseInt(hex,16)};
      }));
      const rows=results.map((r,i)=> r.status==="fulfilled"
        ? `<tr><td>${names[i]}</td><td class="ok">OK</td><td class="mono">${r.value.dec} (${r.value.hex})</td></tr>`
        : `<tr><td>${names[i]}</td><td class="bad">FAIL</td><td class="mono">${(r.reason&&r.reason.message)||String(r.reason)}</td></tr>`
      ).join("");
      box.innerHTML=`<table><tr><th>RPC</th><th>结果</th><th>nonce</th></tr>${rows}</table>`;
      $("aux_status").textContent="完成";
    }catch(e){ $("aux_status").textContent="错误："+e.message; box.innerHTML=""; }
  };

  const EXPLORERS={
    1:"https://etherscan.io", 11155111:"https://sepolia.etherscan.io", 5:"https://goerli.etherscan.io",
    10:"https://optimistic.etherscan.io", 42161:"https://arbiscan.io", 137:"https://polygonscan.com",
    8453:"https://basescan.org", 56:"https://bscscan.com", 43114:"https://snowtrace.io"
  };
  $("btn_open_addr").onclick=async ()=>{
    try{
      if(!gChainId){
        const [u1]=requireRPCs();
        gChainId=parseInt(await rpc(u1,"eth_chainId",[]),16);
      }
      const base=EXPLORERS[gChainId]; if(!base) throw new Error("未知浏览器域名");
      const a=($("addr").value||"").trim(); if(!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("地址不合法");
      window.open(base+"/address/"+a,"_blank");
    }catch(e){ $("aux_status").textContent="错误："+e.message; }
  };

})();
