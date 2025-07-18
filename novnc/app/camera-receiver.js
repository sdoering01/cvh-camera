document.addEventListener('DOMContentLoaded', function() {
    var server = 'https://' + window.location.hostname + ':8089/janus';

    var janus = null;
    var janusPluginHandles = {};
    var janusInitialised = false;
    var opaqueId = 'camera-receiver-' + Janus.randomString(12);

    var room = 1000;

    var passwordButton = document.getElementById('noVNC_password_button');
    if (passwordButton == null) {
        passwordButton = document.getElementById('noVNC_credentials_button');
    }
    var passwordInput = document.getElementById('noVNC_password_input');
    var currentPassword = '';
    var pin = '';

    parsePasswordFromURL();

    passwordInput.addEventListener('input', function(event) {
        currentPassword = event.target.value;
    });

    passwordButton.onclick = function() {
        pin = currentPassword;
    };

    parseRoomFromURL();

    var socketNumber = room + 4000;
    var socket = io('https://' + window.location.hostname, { path: '/socket.io/' + socketNumber.toString() });
    var socketLogicMounted = false;
    // Every property (slot) holds a string that represents the active geometry for that camera slot
    var videoActiveGeometry = {};
    var previousCanvasGeometryState = {
        vncHeight: 0,
        vncWidth: 0,
        canvasHeight: 0,
        canvasWidth: 0,
        canvasX: 0,
        canvasY: 0
    };
    var videoGeometryParams = {};
    // Every video slot has the following structure
    // {
    //     origin: 'lt',
    //     x: 0,
    //     y: 0,
    //     w: 0,
    //     h: 0,
    //     z: 0
    // }
    var source = {};

    var videoPrescale = 1;
    parseVideoPrescaleFromURL();

    socket.on('connect', function() {
        console.log('camera-receiver socket connected');
        // Checks when to mount the event listeners on the logic
        var socketMountCheckInterval = setInterval(function () {
            // Video element and vnc canvas must be mounted
            if (
                janusInitialised &&
                document.querySelector('canvas') != null &&
                document.documentElement.classList.contains('noVNC_connected')
            ) {
                clearInterval(socketMountCheckInterval);
                // Should only be triggered once, but the connect event
                // can be triggered multiple times for example when reconnecting
                if (!socketLogicMounted) {
                    socketLogicMounted = true;
                    console.log('mount socket logic');
                    registerSocketHandlers();
                    setInterval(adjustVideoGeometry, 500);
                }
                socket.emit('query_state', handleQueryStateResponse);
            }
        }, 500);
    });

    function handleQueryStateResponse(cameraStates) {
        console.log('handleQueryStateResponse:', cameraStates);
        Object.keys(cameraStates).forEach(function(slot) {
            var state = cameraStates[slot];
            newRemoteFeed(slot, state.feedId, {
                geometry: state.geometry, 
                visibility: state.visibility,
                annotation: state.annotation
            });
        });
    }

    Janus.init({ debug: true, callback: function() {
        if (!Janus.isWebrtcSupported()) {
            alert('No WebRTC support... ');
            return;
        }

        janus = new Janus({
            server,
            success: function() {
                console.log('Janus initialised');
                janusInitialised = true;
            },
            error: function(error) {
                var formattedError = JSON.stringify(error, null, 2);
                Janus.error(formattedError);
                alert('Janus error: ' + formattedError);
            },
            destroyed: function() {
                alert('Janus stopped');
            }
        });
    }});

    function getVideoContainer(slot) {
        return document.getElementById(`camera-feed-${slot}-container`);
    }

    function removeRemoteFeed(slot) {
        delete videoActiveGeometry[slot];
        delete videoGeometryParams[slot];
        delete source[slot];
        var videoContainer = getVideoContainer(slot);
        if (videoContainer) {
            videoContainer.remove();
        } else {
            console.error(`Tried to remove video container for slot ${slot} that is not mounted`);
        }
        if (janusPluginHandles[slot]) {
            janusPluginHandles[slot].detach();
            delete janusPluginHandles[slot];
        } else {
            console.error(`Tried to remove janus plugin handle for slot ${slot}`);
        }
    }

    function newRemoteFeed(slot, feedId, initialState) {
        source[slot] = feedId;
        var cameraElementId = 'camera-feed-' + slot;

        var videoEl = document.getElementById(cameraElementId);
        if (videoEl == null) {
            var videoContainer = document.createElement('div');
            videoContainer.setAttribute('id', cameraElementId + '-container');
            videoContainer.classList.add('camera-feed-container');

            videoEl = document.createElement('video');
            videoEl.setAttribute('id', cameraElementId);
            videoEl.setAttribute('muted', '');
            videoEl.setAttribute('autoplay', '');
            videoEl.setAttribute('playsinline', '');
            // Necessary for autoplay without user interaction
            videoEl.oncanplaythrough = function() {
                videoEl.muted = true;
                videoEl.play();
            }
            videoEl.classList.add('camera-feed');

            document.body.appendChild(videoContainer);
            videoContainer.appendChild(videoEl);
        }

        attachSubscriber(slot, feedId);

        handleCommand(slot, initialState.geometry.command, initialState.geometry.params);
        handleCommand(slot, initialState.visibility.command, initialState.visibility.params);
        if (initialState.annotation) {
            setAnnotation(slot, initialState.annotation);
        }
    }

    function reconnectRemoteFeed(slot) {
        if (janusPluginHandles[slot] != null) {
            janusPluginHandles[slot].detach();
        }
        var feedId = source[slot];
        attachSubscriber(slot, feedId);
    }

    function attachSubscriber(slot, feedId) {
        janus.attach({
            plugin: 'janus.plugin.videoroom',
            opaqueId,
            success: function(pluginHandle) {
                janusPluginHandles[slot] = pluginHandle;
                Janus.log('Plugin attached (subscriber slot ' + slot + ')! (' + pluginHandle.getPlugin() + ', id=' + pluginHandle.getId() + ')');
                var listen = {
                    request: 'join',
                    room,
                    ptype: 'subscriber',
                    feed: feedId,
                    pin
                };
                pluginHandle.send({ message: listen });
            },
            error: function(error) {
                var formattedError = JSON.stringify(error, null, 2);
                Janus.error('Error attaching plugin (subscriber slot ' + slot + '): ', formattedError);
                alert(formattedError);
            },
            onmessage: handleMessageSubscriber.bind(null, slot),
            onremotestream: function(stream) {
                var cameraEl = document.getElementById('camera-feed-' + slot);
                Janus.attachMediaStream(cameraEl, stream);
            },
            iceState: function handleIceState(state) {
                if (state === 'failed') {
                    console.warn(`iceState of slot ${slot} changed to failed`);
                    console.log('Trying to reconnect');
                    reconnectRemoteFeed(slot);
                    console.log('%cICE failed - bitte Screenshot vom Verlauf dieser Konsole machen und an Professor Gerwinski oder Simon Döring (simon.doering@stud.hs-bochum.de) schicken. Bitte auch schauen, ob noch/wieder alle Kamera-Bilder zu sehen sind, ohne die Seite neu zu laden!', 'font-size: 20px; background: #f55');
                } else {
                    console.log(`iceState of slot ${slot} changed to: ${state}`);
                }
            },
            oncleanup: function() {
                Janus.log('Got a cleanup notification');
            }
        });
    }

    function handleMessageSubscriber(slot, msg, jsep) {
        var remoteFeedHandle = janusPluginHandles[slot];
        var event = msg['videoroom'];
        if (event) {
            if (event === 'attached') {
                Janus.log('Successfully attached to feed on slot ' + slot + ' in room ' + msg['room']);
            } else if (event === 'event') {
                if (msg['error']) {
                    console.error('handleMessageSubscriber', msg['error']);
                }
            }
        }
        if (jsep) {
            remoteFeedHandle.createAnswer({
                jsep,
                media: { audioSend: false, videoSend: false },
                success: function(jsep) {
                    var body = {
                        request: 'start',
                        room
                    };
                    remoteFeedHandle.send({ message: body, jsep });
                },
                error: function(error) {
                    var formattedError = JSON.stringify(error, null, 2);
                    Janus.error('WebRTC error:', formattedError);
                    alert('WebRTC error: ', formattedError);
                }
            });
        }
    }

    function parseRoomFromURL() {
        var urlParams = new URLSearchParams(window.location.search);
        var roomParam = urlParams.get('room');
        if (roomParam != null && !isNaN(roomParam)) {
            room = parseInt(roomParam);
        } else {
            console.log('Got no valid room in URL search params, using default room ' + room);
        }
    }

    function parsePasswordFromURL() {
        var urlParams = new URLSearchParams(window.location.search);
        var passwordParam = urlParams.get('password');
        if (passwordParam != null) {
            pin = passwordParam;
            console.log('pin = ' + pin);
        }
    }

    function parseVideoPrescaleFromURL() {
        var urlParams = new URLSearchParams(window.location.search);
        var videoPrescaleParam = urlParams.get('video_prescale');
        if (videoPrescaleParam != null) {
            var fraction = videoPrescaleParam.split('/');
            var numerator = parseInt(fraction[0]);
            var denominator = parseInt(fraction[1]);
            videoPrescale = numerator / denominator;
            console.log('videoPrescale = ' + videoPrescale);
        }
    }

    function registerSocketHandlers() {
        socket.on('command', function (data) {
            handleCommand(data.slot, data.command, data.params);
        });

        socket.on('new_feed', function(data) {
            console.log('new_feed', data);
            newRemoteFeed(data.slot, data.feedId, {
                geometry: data.geometry,
                visibility: data.visibility,
                annotation: data.annotation
            });
        });

        socket.on('remove_feed', function(data) {
            console.log('remove_feed', data);
            removeRemoteFeed(data.slot);
        });

        socket.on('remove_all_feeds', function() {
            Object.keys(videoGeometryParams).forEach(function(slot) {
                removeRemoteFeed(slot);
            });
        });

        socket.on('set_annotation', function(data) {
            console.log('set_annotation', data);
            setAnnotation(data.slot, data.annotation);
        });

        socket.on('remove_annotation', function(data) {
            console.log('remove_annotation', data);
            removeAnnotation(data.slot);
        });
    }

    function setAnnotation(slot, annotationHtml) {
        var videoContainer = getVideoContainer(slot);

        if (videoContainer) {
            var template = document.createElement('template');
            template.innerHTML = annotationHtml.trim();
            var annotationEl = template.content.firstChild;
            if (annotationEl && annotationEl.classList) {
                annotationEl.classList.add('annotation');
                var prevAnnotationEl = videoContainer.querySelector('.annotation');
                if (prevAnnotationEl) {
                    prevAnnotationEl.remove();
                }
                videoContainer.appendChild(annotationEl);
            } else {
                console.error(`setAnnotation called for slot ${slot} with invalid HTML ${annotationHtml}`);
            }
        } else {
            console.error(`setAnnotation called for slot ${slot} which has no video container`);
        }
    }

    function removeAnnotation(slot) {
        var videoContainer = getVideoContainer(slot);

        if (videoContainer) {
            var annotationEl = videoContainer.querySelector('.annotation');
            if (annotationEl) {
                annotationEl.remove();
            }
        } else {
            console.error(`removeAnnotation called for slot ${slot} which has no video container`);
        }
    }

    function handleCommand(slot, command, params) {
        console.log('Got command:', command);
        console.log('For slot:', slot);
        console.log('With params:', params);
        var videoContainer = getVideoContainer(slot);
        if (videoContainer == null) {
            console.log('handleCommand videoContainer element is null');
            return;
        }
        switch(command) {
            case 'set_geometry_relative_to_window':
                var origin = params[0];
                var x = params[1];
                var y = params[2];
                var w = params[3];
                var h = params[4];
                var z = 100;
                if (params.length >= 6) {
                    z += parseInt(params[5]);
                }

                setFixedPosition(videoContainer, origin, x, y, w, h, z);
                videoGeometryParams[slot] = { origin, x, y, w, h, z };
                videoActiveGeometry[slot] = command;

                break;
            case 'set_geometry_relative_to_canvas':
                var origin = params[0];
                var x = parseInt(params[1]);
                var y = parseInt(params[2]);
                var w = parseInt(params[3]);
                var h = parseInt(params[4]);
                var z = 100;
                if (params.length >= 6) {
                    z += parseInt(params[5]);
                }

                handleSetGeometryRelativeToCanvas(videoContainer, slot, origin, x, y, w, h, z);

                break;
            case 'show':
                videoContainer.classList.remove('visually-hidden');
                break;
            case 'hide':
                videoContainer.classList.add('visually-hidden');
                break;
            default:
                console.log(`Socket got unknown command '${command}'`);
                break;
        }
    }

    function handleSetGeometryRelativeToCanvas(videoContainer, slot, origin, x, y, w, h, z) {
        // Site contains only one canvas - the vnc viewer
        var canvas = document.querySelector('canvas');
        videoGeometryParams[slot] = { origin, x, y, w, h, z };

        var vncWidth = parseInt(canvas.width);
        var vncHeight = parseInt(canvas.height);
        // Remove 'px' at the end before parsing to int
        var canvasWidth = parseInt(canvas.style.width.slice(0, -2));
        var canvasHeight = parseInt(canvas.style.height.slice(0, -2));

        // width in vnc * factor = width in html
        var factor = canvasWidth / vncWidth;
        factor *= videoPrescale;

        x *= factor;
        y *= factor;
        w *= factor;
        h *= factor;

        var canvasRect = canvas.getBoundingClientRect();
        var xOrigin = origin.charAt(0);
        var yOrigin = origin.charAt(1);
        if (xOrigin === 'l') {
            x += canvasRect.left;
        } else if (xOrigin === 'r') {
            // Explanation
            // _____________________________________
            // |          <-        right        ->|
            // |<- left -><-   width   ->          | 
            // |                                   |
            // |          x x x x x x x x          |
            // |          x    canvas   x          |
            x += (canvasRect.right - canvasRect.width);
        } 

        if (yOrigin === 't') {
            y += canvasRect.top;
        } else if (yOrigin === 'b') {
            // Explanation analog to the one above
            y += (canvasRect.bottom - canvasRect.height);
        }

        setFixedPosition(videoContainer, origin, x, y, w, h, z);
        videoActiveGeometry[slot] = 'set_geometry_relative_to_canvas';
        previousCanvasGeometryState = {
            vncWidth,
            vncHeight,
            canvasWidth,
            canvasHeight,
            canvasX: canvasRect.x,
            canvasY: canvasRect.y
        };
    }

    function setFixedPosition(videoContainer, origin, x, y, w, h, z) {
        var style = ( 
            'position: fixed;' +
            `width: ${w}px;` +
            `height: ${h}px;` +
            `z-index: ${z};`
        );
        
        var xOrigin = origin.charAt(0);
        var yOrigin = origin.charAt(1);
        if (xOrigin === 'l') {
            style += `left: ${x}px;`;
        } else if (xOrigin === 'r') {
            style += `right: ${x}px;`;
        } else {
            console.log('setFixedPosition unknown xOrigin', xOrigin);
            return;
        }
        if (yOrigin === 't') {
            style += `top: ${y}px;`;
        } else if (yOrigin === 'b') {
            style += `bottom: ${y}px;`;
        } else {
            console.log('setFixedPosition unknown yOrigin', yOrigin);
            return;
        }

        videoContainer.setAttribute('style', style);
    }

    function adjustVideoGeometry() {
        var canvas = document.querySelector('canvas');
        if (canvas) {
            var canvasRect = canvas.getBoundingClientRect();
            var vncWidth = canvas.width;
            var vncHeight = canvas.height;
            var canvasWidth = canvasRect.width;
            var canvasHeight = canvasRect.height;
            var canvasX = canvasRect.x;
            var canvasY = canvasRect.y
            if (
                vncWidth !== previousCanvasGeometryState.vncWidth ||
                vncHeight !== previousCanvasGeometryState.vncHeight ||
                canvasWidth !== previousCanvasGeometryState.canvasWidth ||
                canvasHeight !== previousCanvasGeometryState.canvasHeight ||
                canvasX !== previousCanvasGeometryState.canvasX ||
                canvasY !== previousCanvasGeometryState.canvasY
            ) {
                Object.keys(videoGeometryParams).forEach(function(slot) {
                    if (videoActiveGeometry[slot] === 'set_geometry_relative_to_canvas') {
                        var params = videoGeometryParams[slot];
                        handleSetGeometryRelativeToCanvas(
                            getVideoContainer(slot),
                            slot,
                            params.origin,
                            params.x,
                            params.y,
                            params.w,
                            params.h,
                            params.z
                        );
                    }
                });
            }
        } else {
            console.error('adjustVideoGeometry canvas was null');
        }
    }
});

