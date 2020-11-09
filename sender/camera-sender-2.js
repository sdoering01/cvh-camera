var server = 'https://' + window.location.hostname + ':8089/janus';

var janus = null;
var videoroomHandle = null;
var room = 1000;

var startButton = null;
var stopButton = null;

document.addEventListener('DOMContentLoaded', function() {
	startButton = document.getElementById('start');
	stopButton = document.getElementById('stop');

	Janus.init({ debug: 'all', callback: function() {
		if (!Janus.isWebrtcSupported()) {
			alert('No WebRTC support... ');
			return;
		}

		janus = new Janus({
			server: server,
			success: function() {
				janus.attach({
					plugin: 'janus.plugin.videoroom',
					success: function(pluginHandle) {
						videoroomHandle = pluginHandle;
						Janus.log('Plugin attached! (' + videoroomHandle.getPlugin() + ', id=' + videoroomHandle.getId() + ')');	

						startButton.onclick = function() {
							var roomSelect = document.getElementById('room-select');
							startButton.setAttribute('disabled', '');
							roomSelect.setAttribute('disabled', '');
							stopButton.removeAttribute('disabled');
							stopButton.onclick = function() {
								janus.destroy();
							};
							room = parseInt(roomSelect.value);
							shareCamera();
						};
						startButton.removeAttribute('disabled');
					},
					error: function(error) {
						Janus.error('Error attaching plugin: ', error);
						alert(error);
					},
					webrtcState: function(on) {
						if (on) {
							alert('Sharing camera');
						} else {
							janus.destroy();
						}
					},
					onmessage: handleMessage,
					onlocalstream: function(stream) {
						if (document.getElementById('camera-preview') == null) {
							var video = document.createElement('video');
							video.setAttribute('id', 'camera-preview');
							video.setAttribute('width', '100%');
							video.setAttribute('height', '100%');
							video.setAttribute('autoplay', '');
							video.setAttribute('playsinline', '');
							video.setAttribute('muted', 'muted');
							document.getElementById('preview-container').appendChild(video);

							var noVncLink = 'https://simon-doering.com/novnc/vnc.html?room=' + room;
							var linkContainer = document.createElement('div');
							linkContainer.innerHTML = `Camera feed can be viewed in noVNC at this link by clicking the connect button: <a href=${noVncLink}>${noVncLink}</a>`;
							document.body.appendChild(linkContainer);
						}
						Janus.attachMediaStream(document.getElementById('camera-preview'), stream);
					}
				});
			},
			error: function(error) {
				Janus.error(error);
				alert(error);
				window.location.reload();
			},
			destroyed: function() {
				alert('Stopped');
				window.location.reload();
			}
		});
	}});
}, false);

function shareCamera() {
	var register = {
		request: 'join',
		room,
		ptype: 'publisher'
	};
	videoroomHandle.send({ message: register });
}

function handleMessage(msg, jsep) {
	var event = msg['videoroom'];
	if (event) {
		if (event === 'joined') {
			console.log('Joined event:', msg);
			Janus.log('Successfully joined room ' + msg['room'] + ' with ID ' + msg['id']);
			if (msg['publishers'].length === 0) {
				videoroomHandle.createOffer({
					media: {
						videoSend: true,
						audioSend: false,
						videoRecv: false
					},
					success: function(jsep) {
						var publish = {
							request: 'configure',
							audio: false,
							video: true
						};
						videoroomHandle.send({ message: publish, jsep });
					},
					error: function(error) {
						Janus.error('WebRTC error:', error);
						alert('WebRTC error: ' + error.message);
					}
				});
			} else {
				alert('There is already somebody who is sharing his camera in this room!');
				window.location.reload();
			}
		}
		if (event === 'event' && msg['error']) {
			alert(msg['error']);
			window.location.reload();
		}
	}
	if (jsep) {
		videoroomHandle.handleRemoteJsep({ jsep });
	}
};
