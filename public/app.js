const socket = io();

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remoteEmpty = document.getElementById("remoteEmpty");

const countryInput = document.getElementById("countryInput");
const matchInput = document.getElementById("matchInput");

const nextBtn = document.getElementById("nextBtn");
const stopBtn = document.getElementById("stopBtn");

const statusText = document.getElementById("statusText");
const partnerText = document.getElementById("partnerText");
const statusDot = document.getElementById("statusDot");
const remoteLabel = document.getElementById("remoteLabel");

const messages = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");

let localStream = null;
let peer = null;
let partnerId = null;
let started = false;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

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
}

async function joinQueue() {
  try {
    await startCamera();

    cleanupCall();

    started = true;
    stopBtn.disabled = false;

    messages.innerHTML = "";
    addSystem("SEARCHING...");
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
  addSystem("SEARCHING...");
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

  addMessage(text, true);
  socket.emit("chat-message", text);
  messageInput.value = "";
}

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
  addMessage(payload.text, false);
});

socket.on("partner-left", () => {
  cleanupCall();

  if (started) {
    setStatus("Searching", "Partner left. Press NEXT.", "searching");
    addSystem("PARTNER LEFT.");
  }
});

socket.on("stopped", () => {
  setStatus("Stopped", "", "");
});
