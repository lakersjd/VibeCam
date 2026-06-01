const socket = io();

const landingPage = document.getElementById("landingPage");
const banScreen = document.getElementById("banScreen");
const banReason = document.getElementById("banReason");
const banExpires = document.getElementById("banExpires");

const enterChatBtn = document.getElementById("enterChatBtn");
const enterWarning = document.getElementById("enterWarning");
const ageCheck = document.getElementById("ageCheck");
const homeBtn = document.getElementById("homeBtn");

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remoteEmpty = document.getElementById("remoteEmpty");

const countryInput = document.getElementById("countryInput");
const matchInput = document.getElementById("matchInput");

const nextBtn = document.getElementById("nextBtn");
const stopBtn = document.getElementById("stopBtn");
const micBtn = document.getElementById("micBtn");
const camBtn = document.getElementById("camBtn");
const reportBtn = document.getElementById("reportBtn");

const statusText = document.getElementById("statusText");
const partnerText = document.getElementById("partnerText");
const statusDot = document.getElementById("statusDot");
const remoteLabel = document.getElementById("remoteLabel");

const messages = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");

const safetyCanvas = document.getElementById("safetyCanvas");
const safetyCtx = safetyCanvas.getContext("2d", { willReadFrequently: true });

const cameraSafety = document.getElementById("cameraSafety");
const micSafety = document.getElementById("micSafety");
const warningCount = document.getElementById("warningCount");

let localStream = null;
let peer = null;
let partnerId = null;
let started = false;
let micOn = true;
let camOn = true;
let warnings = 0;
let localExposureHits = 0;
let remoteExposureHits = 0;
let cameraScanTimer = null;
let speechRecognition = null;
let bannedNow = false;

const racistPatterns = [
  "\u006e\u0069\u0067\u0067\u0065\u0072",
  "\u006e\u0069\u0067\u0067\u0061",
  "\u0063\u006f\u006f\u006e",
  "\u0063\u0068\u0069\u006e\u006b",
  "\u0073\u0070\u0069\u0063",
  "\u0077\u0065\u0074\u0062\u0061\u0063\u006b",
  "\u006b\u0069\u006b\u0065",
  "\u0072\u0061\u0067\u0068\u0065\u0061\u0064",
  "\u0073\u0061\u006e\u0064\u006e\u0069\u0067\u0067\u0065\u0072",
  "white power",
  "heil hitler",
  "go back to your country"
];

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

function setSavedPage(page) {
  localStorage.setItem("vibechat_page", page);

  if (page === "chat") {
    landingPage.classList.add("hidden");
  } else {
    landingPage.classList.remove("hidden");
  }
}

const savedPage = localStorage.getItem("vibechat_page") || "landing";
setSavedPage(savedPage);

function getProfile() {
  return {
    wantsGender: matchInput.value || "Any",
    country: countryInput.value || "Any"
  };
}

function setStatus(title, detail, mode) {
  statusText.textContent = title;
  partnerText.textContent = detail || "";

  statusDot.className = "statusDot";
  if (mode) statusDot.classList.add(mode);
}

function setSafetyText(element, text, level) {
  element.textContent = text;
  element.className = level || "";
}

function addSystem(text) {
  const div = document.createElement("div");
  div.className = "systemMsg";
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function addMessage(text, mine) {
  const div = document.createElement("div");
  div.className = "msg " + (mine ? "me" : "them");
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function addWarning(reason) {
  warnings += 1;
  warningCount.textContent = "WARNINGS: " + warnings;
  warningCount.className = warnings >= 3 ? "danger" : "warn";
  console.warn("Safety warning:", reason);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[@]/g, "a")
    .replace(/[!1|]/g, "i")
    .replace(/[$5]/g, "s")
    .replace(/[0]/g, "o")
    .replace(/[3]/g, "e")
    .replace(/\s+/g, " ")
    .trim();
}

function containsRacism(text) {
  const clean = normalizeText(text);
  const compact = clean.replace(/[^a-z0-9]/g, "");

  return racistPatterns.some(pattern => {
    const p = normalizeText(pattern);
    const compactPattern = p.replace(/[^a-z0-9]/g, "");
    return clean.includes(p) || compact.includes(compactPattern);
  });
}

function showBanScreen(reason, expiresAt) {
  bannedNow = true;
  banReason.textContent = "Reason: " + reason;
  banExpires.textContent = "Expires: " + new Date(expiresAt).toLocaleString();
  landingPage.classList.add("hidden");
  banScreen.classList.remove("hidden");
}

async function startCamera() {
  if (localStream) return;

  localStream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: true
  });

  localVideo.srcObject = localStream;

  micBtn.disabled = false;
  camBtn.disabled = false;

  setSafetyText(cameraSafety, "CAMERA: SCANNING", "safe");
  setSafetyText(micSafety, "MIC: RACISM CHECK", "safe");

  startCameraSafetyScan();
  startMicSafetyScan();
}

function applyMediaToggles() {
  if (!localStream) return;

  localStream.getAudioTracks().forEach(track => {
    track.enabled = micOn;
  });

  localStream.getVideoTracks().forEach(track => {
    track.enabled = camOn;
  });

  micBtn.classList.toggle("off", !micOn);
  camBtn.classList.toggle("off", !camOn);

  setSafetyText(micSafety, micOn ? "MIC: RACISM CHECK" : "MIC: OFF", micOn ? "safe" : "warn");
  setSafetyText(cameraSafety, camOn ? "CAMERA: SCANNING" : "CAMERA: OFF", camOn ? "safe" : "warn");
}

function privateAreaScore(videoElement) {
  if (!videoElement || !videoElement.videoWidth) return 0;

  safetyCtx.drawImage(videoElement, 0, 0, safetyCanvas.width, safetyCanvas.height);

  const frame = safetyCtx.getImageData(0, 0, safetyCanvas.width, safetyCanvas.height);
  const data = frame.data;

  let skinLike = 0;
  let total = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const brightness = (r + g + b) / 3;

    const skinPixel =
      r > 85 &&
      g > 35 &&
      b > 15 &&
      max - min > 12 &&
      r > g &&
      r > b &&
      brightness > 45 &&
      brightness < 235;

    if (skinPixel) skinLike++;
  }

  return skinLike / total;
}

function startCameraSafetyScan() {
  if (cameraScanTimer) clearInterval(cameraScanTimer);

  cameraScanTimer = setInterval(() => {
    if (bannedNow) return;

    if (camOn && localVideo.videoWidth) {
      const localScore = privateAreaScore(localVideo);

      if (localScore > 0.68) {
        localExposureHits += 1;
        setSafetyText(cameraSafety, "YOUR CAMERA: POSSIBLE EXPOSURE " + localExposureHits + "/2", "danger");

        if (localExposureHits >= 2) {
          console.warn("Possible private-area exposure detected.");
          socket.emit("safety-exposure-self");
          stopMatching();
          return;
        }
      } else {
        localExposureHits = 0;
        setSafetyText(cameraSafety, "CAMERA: CLEAR", "safe");
      }
    }

    if (remoteVideo.srcObject && remoteVideo.videoWidth) {
      const remoteScore = privateAreaScore(remoteVideo);

      if (remoteScore > 0.68) {
        remoteExposureHits += 1;
        setSafetyText(cameraSafety, "STRANGER: POSSIBLE EXPOSURE " + remoteExposureHits + "/2", "danger");

        if (remoteExposureHits >= 2) {
          addSystem("STRANGER REMOVED BY SAFETY SYSTEM.");
          socket.emit("safety-exposure-partner");
          cleanupCall();
          remoteExposureHits = 0;
        }
      } else {
        remoteExposureHits = 0;
      }
    }
  }, 3000);
}

function startMicSafetyScan() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    setSafetyText(micSafety, "MIC: SPEECH CHECK NOT SUPPORTED", "warn");
    return;
  }

  if (speechRecognition) {
    speechRecognition.stop();
    speechRecognition = null;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = "en-US";

  speechRecognition.onresult = event => {
    let transcript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript + " ";
    }

    if (containsRacism(transcript)) {
      setSafetyText(micSafety, "MIC: RACISM DETECTED", "danger");
      addWarning("Racism detected on mic.");
    } else if (micOn) {
      setSafetyText(micSafety, "MIC: CLEAR", "safe");
    }
  };

  speechRecognition.onerror = () => {
    setSafetyText(micSafety, "MIC: SPEECH CHECK LIMITED", "warn");
  };

  speechRecognition.onend = () => {
    if (started && micOn) {
      try {
        speechRecognition.start();
      } catch (error) {}
    }
  };

  try {
    speechRecognition.start();
  } catch (error) {
    setSafetyText(micSafety, "MIC: SPEECH CHECK LIMITED", "warn");
  }
}

function createPeer() {
  if (peer) peer.close();

  peer = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      peer.addTrack(track, localStream);
    });
  }

  peer.ontrack = event => {
    remoteVideo.srcObject = event.streams[0];
    remoteEmpty.style.display = "none";
  };

  peer.onicecandidate = event => {
    if (event.candidate && partnerId) {
      socket.emit("signal", {
        to: partnerId,
        data: {
          type: "ice",
          candidate: event.candidate
        }
      });
    }
  };

  peer.onconnectionstatechange = () => {
    if (!peer) return;

    if (peer.connectionState === "connected") {
      setStatus("Connected", "Live with stranger.", "live");
    }

    if (
      peer.connectionState === "failed" ||
      peer.connectionState === "disconnected" ||
      peer.connectionState === "closed"
    ) {
      remoteEmpty.style.display = "grid";
    }
  };
}

function cleanupCall() {
  if (peer) {
    peer.close();
    peer = null;
  }

  partnerId = null;
  remoteVideo.srcObject = null;
  remoteEmpty.style.display = "grid";
  remoteLabel.textContent = "STRANGER";
  sendBtn.disabled = true;
  reportBtn.disabled = true;
}

async function joinQueue() {
  try {
    await startCamera();
    applyMediaToggles();

    cleanupCall();

    started = true;
    stopBtn.disabled = false;

    messages.innerHTML = "";
    console.log("SEARCHING...");
    setStatus("Searching", "Finding a match...", "searching");

    socket.emit("join", getProfile());
  } catch (error) {
    addSystem("CAMERA OR MICROPHONE BLOCKED.");
    setStatus("Camera blocked", "Allow camera and microphone, then press NEXT.", "");
    console.error(error);
  }
}

function nextMatch() {
  if (!started) {
    joinQueue();
    return;
  }

  cleanupCall();
  messages.innerHTML = "";
  console.log("SEARCHING...");
  setStatus("Searching", "Finding a match...", "searching");

  socket.emit("next", getProfile());
}

function stopMatching() {
  socket.emit("stop");

  cleanupCall();
  started = false;

  stopBtn.disabled = true;
  setStatus("Stopped", "", "");
  messages.innerHTML = "";
}

async function handleMatched(data) {
  partnerId = data.partnerId;

  const partnerMatch = data.partner?.wantsGender || "Random";
  const partnerCountry = data.partner?.country || "Unknown";

  remoteLabel.textContent = "STRANGER";
  setStatus("Matched", partnerCountry + " | Match: " + partnerMatch, "live");

  sendBtn.disabled = false;
  reportBtn.disabled = false;

  messages.innerHTML = "";
  addSystem("MATCHED.");

  createPeer();

  if (data.initiator) {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    socket.emit("signal", {
      to: partnerId,
      data: {
        type: "offer",
        sdp: offer
      }
    });
  }
}

async function handleSignal(payload) {
  if (!peer) createPeer();

  const data = payload.data;

  if (data.type === "offer") {
    await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    socket.emit("signal", {
      to: payload.from,
      data: {
        type: "answer",
        sdp: answer
      }
    });
  }

  if (data.type === "answer") {
    await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
  }

  if (data.type === "ice") {
    try {
      await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (error) {
      console.warn("ICE error:", error);
    }
  }
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !partnerId) return;

  if (containsRacism(text)) {
    addWarning("Racist chat message blocked.");
    messageInput.value = "";
    return;
  }

  addMessage(text, true);
  socket.emit("chat-message", text);
  messageInput.value = "";
}

enterChatBtn.addEventListener("click", () => {
  if (!ageCheck.checked) {
    enterWarning.textContent = "You must confirm 18+ and agree to the rules.";
    return;
  }

  enterWarning.textContent = "";
  setSavedPage("chat");
});

homeBtn.addEventListener("click", () => {
  stopMatching();
  setSavedPage("landing");
});

micBtn.addEventListener("click", () => {
  micOn = !micOn;
  applyMediaToggles();
});

camBtn.addEventListener("click", () => {
  camOn = !camOn;
  applyMediaToggles();
});

reportBtn.addEventListener("click", () => {
  if (!partnerId) return;

  const reason = prompt("Report reason:");
  socket.emit("report-partner", reason || "Manual report");
  addSystem("REPORT SENT.");
  cleanupCall();
});

nextBtn.addEventListener("click", nextMatch);
stopBtn.addEventListener("click", stopMatching);
sendBtn.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", event => {
  if (event.key === "Enter") sendMessage();
});

socket.on("queued", data => {
  setStatus("Searching", "Online: " + data.online + " | Waiting: " + data.waiting, "searching");
});

socket.on("matched", payload => {
  handleMatched(payload).catch(error => console.error(error));
});

socket.on("signal", payload => {
  handleSignal(payload).catch(error => console.error(error));
});

socket.on("chat-message", payload => {
  if (containsRacism(payload.text)) {
    addWarning("Racist incoming chat message blocked.");
    return;
  }

  addMessage(payload.text, false);
});

socket.on("partner-left", () => {
  cleanupCall();

  if (started) {
    setStatus("Searching", "Partner left. Press NEXT.", "searching");
    addSystem("PARTNER LEFT.");
  }
});

socket.on("banned", data => {
  stopMatching();
  showBanScreen(data.reason, data.expiresAt);
});

socket.on("stopped", () => {
  setStatus("Stopped", "", "");
});


