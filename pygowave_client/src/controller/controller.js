/*
 * PyGoWave Client Script a.k.a. Microwave
 * Copyright (C) 2009 by p2k
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

/**
 * <p>This collection of JavaScript libraries represent the PyGoWave Client
 * interface for web browsers. It communicates seamlessly with any PyGoWave
 * Server instance.</p>
 * <p>PyGoWave Client is designed with the Model-View-Controller design
 * pattern.</p>
 * <p>To set up PyGoWave Client for proper operation, you must include
 * Orbited.js and stomp.js before any of these scripts. Then include all three
 * libraries in arbitrary order. (TODO...)</p>
 * 
 * @project PyGoWave Client
 * @author p2k - patrick.p2k.schneider@gmail.com
 * @version 0.1.0
 * @description PyGoWave JavaScript Client a.k.a. Microwave
 */

/**
 * Root object of the namespace.
 *
 * @namespace pygowave
 */
window.pygowave = $defined(window.pygowave) ? window.pygowave : new Hash();

pygowave.controller = $defined(pygowave.controller) ? pygowave.controller : new Hash();

/**
 * Controller module.
 * @module pygowave.controller
 */
(function () {
	// -- Private classes --
	
	// -- Public classes --
	
	/**
	 * Controller class; handles all user input and server-communication.
	 * 
	 * @class {public} pygowave.controller.PyGoWaveClient
	 */
	var PyGoWaveClient = new Class({
		Implements: [Options, Events],
		options: {
			stompServer: "localhost",
			stompPort: 61613,
			stompUsername: "pygowave_client",
			stompPassword: "pygowave_client",
			
			waveAccessKeyRx: "",
			waveAccessKeyTx: "",
			initialWave: "",
			initialWavelet: "",
			viewerId: "",
			pingInterval: 10,
			
			waveOverviewUrl: "about:blank"
		},
		
		// --- Event documentation ---
		/**
		 * Fired on wavelet opening.
		 * @event onWaveletOpened
		 * @param {String} wave_id ID of the wave
		 * @param {String} wavelet_id ID of the wavelet
		 */
		/**
		 * Fired on a successfully returned Ping message.
		 * @event onPing
		 * @param {int} latency Measured latency in milliseconds
		 */
		// ---------------------------
		
		/**
		 * Called on instantiation.
		 * @constructor {public} initialize
		 * @param {pygowave.model.WaveModel} model Initial wave model
		 * @param {pygowave.view.WaveView} view Initial wave view
		 * @param {Object} options Client configuration options
		 */
		initialize: function(model, view, options) {
			this.setOptions(options);
			
			this._iview = view;
			this._iview.addEvent('textInserted', this._onTextInserted.bind(this));
			this._iview.addEvent('textDeleted', this._onTextDeleted.bind(this));
			this._iview.addEvent('elementInsert', this._onElementInsert.bind(this));
			this._iview.addEvent('elementDelete', this._onElementDelete.bind(this));
			this._iview.addEvent('elementDeltaSubmitted', this._onElementDeltaSubmitted.bind(this));
			this._iview.addEvent('elementSetUserpref', this._onElementSetUserpref.bind(this));
			this._iview.addEvent('searchForParticipant', this._onSearchForParticipant.bind(this));
			this._iview.addEvent('addParticipant', this._onAddParticipant.bind(this));
			this._iview.addEvent('leaveWavelet', this._onLeaveWavelet.bind(this));
			this._iview.addEvent('refreshGadgetList', this._onRefreshGadgetList.bind(this));
			this._iview.addEvent('ready', this._onViewReady.bind(this));
			
			this.waves = new Hash();
			this.waves.set(model.id(), model);
			
			this.wavelets = new Hash();
			this.new_participants = new Array();
			this.participants = new Hash();
			this._cachedGadgetList = null;
			this._deferredMessageBundles = new Array();
			this._processingDeferred = false;
			this._pendingTimer = null;
			this._pingTimer = null;
			
			// The connection object must be stored in this.conn and must have a sendJson and subscribeWavelet method (defined below).
			this.conn = new STOMPClient(); // STOMP is used as communication protocol
			var self = this;
			$extend(this.conn, {
				onclose: function(c) {self.onConnClose(c);},
				onerror: function(e) {self.onConnError(e);},
				onconnectedframe: function() {
					self.openWavelet(self.options.initialWave, self.options.initialWavelet);
				},
				onmessageframe: function(frame) {
					self.onConnReceive(frame.headers.destination.split(".")[1], JSON.decode(frame.body));
				},
				sendJson: function (wavelet_id, obj) {
					this.send(
						JSON.encode(obj),
						self.options.waveAccessKeyTx + "." + wavelet_id + ".clientop",
						{
							exchange: "wavelet.topic",
							"content-type": "application/json"
						}
					);
					self._resetPingTimer()
				},
				subscribeWavelet: function (wavelet_id) {
					this.subscribe(
						self.options.waveAccessKeyRx + "." + wavelet_id + ".waveop",
						{
							routing_key: self.options.waveAccessKeyRx + "." + wavelet_id + ".waveop",
							exchange: "wavelet.direct",
							exclusive: true
						}
					);
					this.sendJson(wavelet_id, {"type": "WAVELET_OPEN"});
				}
			});
		},
		
		/**
		 * Callback for server connection socket.
		 * Handles connection close; delayed for two seconds to prevent this
		 * message from showing on willing disconnection.
		 * 
		 * @function {private} onConnClose
		 * @param {int} code Error code provided by socket API.
		 */
		onConnClose: function (code) {
			this._iview.showControllerError.delay(2000, this._iview, gettext("The connection was lost.<br/><br/>Error code: %d").sprintf(code));
		},
		
		/**
		 * Callback for server connection socket.
		 * Handles connection errors.
		 * 
		 * @function {private} onConnError
		 * @param {int} code Error code provided by socket API.
		 */
		onConnError: function (code) {
			this._iview.showControllerError(gettext("A connection error occured.<br/><br/>Error code: %d").sprintf(code));
		},
		
		/**
		 * Callback for server connection socket.
		 * Dispatches incoming server messages.
		 * 
		 * @function {private} onConnReceive
		 * @param {object} msg JSON-decoded message object for processing.
		 */
		onConnReceive: function (wavelet_id, msg) {
			var wavelet_model = null;
			if (this.wavelets.has(wavelet_id))
				wavelet_model = this.wavelets[wavelet_id].model;
			
			for (var it = new _Iterator(msg);it.hasNext();) {
				msg = it.next();
				switch (msg.type) {
					case "WAVELET_OPEN":
						this._setupPingTimer();
						this._collateParticipants(msg.property.wavelet.participants);
						
						var wave_id = msg.property.wavelet.waveId;
						var wave_model = this.waves[wave_id];
						wave_model.loadFromSnapshot(msg.property, this.participants);
						this.wavelets[wavelet_id] = {
							model: wave_model.wavelet(wavelet_id),
							pending: false,
							blocked: false
						};
						this._setupOpManagers(wave_id, wavelet_id);
						this.fireEvent("waveletOpened", [wave_id, wavelet_id]);
						
						this._requestParticipantInfo(wavelet_id);
						break;
					case "OPERATION_MESSAGE_BUNDLE_ACK":
						this._queueMessageBundle(wavelet_model, "ACK", msg.property.version, msg.property.blipsums);
						break;
					case "OPERATION_MESSAGE_BUNDLE":
						this._queueMessageBundle(wavelet_model, msg.property.operations, msg.property.version, msg.property.blipsums);
						break;
					case "PARTICIPANT_INFO":
						this._processParticipantsInfo(msg.property);
						break;
					case "PARTICIPANT_SEARCH":
						if (msg.property.result == "OK") {
							this._collateParticipants(msg.property.data);
							this._iview.updateSearchResults(this._getParticipants(msg.property.data));
							this._requestParticipantInfo(wavelet_id);
						}
						else if (msg.property.result == "TOO_SHORT")
							this._iview.invalidSearch(msg.property.data);
						break;
					case "WAVELET_ADD_PARTICIPANT":
						this._collateParticipants([msg.property]);
						wavelet_model.addParticipant(this.participants[msg.property]);
						this._requestParticipantInfo(wavelet_id);
						break;
					case "WAVELET_REMOVE_PARTICIPANT":
						if (msg.property == this.options.viewerId) {
							// Bye bye
							this.conn.disconnect();
							window.location.href = this.options.waveOverviewUrl;
							return;
						}
						else
							wavelet_model.removeParticipant(msg.property);
						break;
					case "GADGET_LIST":
						this._cachedGadgetList = msg.property;
						this._iview.updateGadgetList(msg.property);
						break;
					case "PONG":
						this.fireEvent("ping", $time() - msg.property);
						break;
				}
			}
		},
		
		/**
		 * Connect to the server and load the initial wavelet
		 * @function {public} connect
		 */
		connect: function () {
			this.conn.connect(
				this.options.stompServer,
				this.options.stompPort,
				this.options.stompUsername,
				this.options.stompPassword
			);
		},
		/**
		 * Returns if the given wavelet's transmission is blocked
		 * @function {public} isBlocked
		 * @param {String} wavelet_id ID of the Wavelet
		 */
		isBlocked: function (wavelet_id) {
			return this.wavelets[wavelet_id].blocked;
		},
		/**
		 * Block or unblock the transmission of messages for debugging purposes.
		 * @function {public} setBlocked
		 * @param {String} wavelet_id ID of the Wavelet whose messages should
		 *     be blocked
		 * @param {Boolean} blocked Set to true to disable message transmission,
		 *     false to re-enable it (may send queued messages).
		 */
		setBlocked: function (wavelet_id, blocked) {
			this.wavelets[wavelet_id].blocked = blocked;
			if (!blocked && !this.wavelets[wavelet_id].pending && this.hasPendingOperations(wavelet_id))
				this._transferOperations(wavelet_id);
		},
		
		/**
		 * Open a wavelet.
		 * @function {public} openWavelet
		 * @param {String} wave_id ID of the wave of the wavelet
		 * @param {String} wavelet_id ID of the wavelet to open
		 */
		openWavelet: function (wave_id, wavelet_id) {
			if (!this.waves.has(wave_id))
				this.waves[wave_id] = new pygowave.model.WaveModel(wave_id, this.options.viewerId);
			
			this.conn.subscribeWavelet(wavelet_id);
		},
		
		/**
		 * Returns true if this wavelet has pending operations.
		 * @function {public Boolean} hasPendingOperations
		 * @param {String} wavelet_id ID of the wavelet
		 */
		hasPendingOperations: function (wavelet_id) {
			return this.wavelets[wavelet_id].pending || !this.wavelets[wavelet_id].mpending.isEmpty();
		},
		
		/**
		 * Setup the Ping timer which will periodically send a Ping message
		 * if no other messages were sent. Does nothing if the Ping timer has
		 * already been set up.
		 * 
		 * Developer's note: Although "delay" is used instead of "periodical"
		 * this effectively generates a periodical timer, because the timer
		 * is always reset if a message (in this case the PING message) is sent.
		 * 
		 * @function {private} _setupPingTimer
		 */
		_setupPingTimer: function () {
			if (!$defined(this._pingTimer))
				this._pingTimer = this._sendPing.delay(this.options.pingInterval * 1000, this);
		},
		/**
		 * Resets the Ping timer. Called if some other message was sent.
		 * @function {private} _resetPingTimer
		 */
		_resetPingTimer: function () {
			if ($defined(this._pingTimer)) {
				$clear(this._pingTimer);
				this._pingTimer = null;
				this._setupPingTimer();
			}
		},
		/**
		 * Sends a Ping command. Called by the Ping timer.
		 * @function {private} _sendPing
		 */
		_sendPing: function () {
			// Pick first wavelet
			wavelet_id = this.wavelets.getKeys()[0];
			if (!$defined(wavelet_id))
				return;
			this.conn.sendJson(wavelet_id, {
				type: "PING",
				property: $time()
			});
		},
		/**
		 * Collate the internal participant "database" with the given ID list.
		 * New participants will be added to the new_participants array, so
		 * they can be retrieved later.
		 * @function {private} _collateParticipants
		 * @param {String[]} id_list List of participant IDs
		 */
		_collateParticipants: function (id_list) {
			for (var it = new _Iterator(id_list);it.hasNext();) {
				var id = it.next();
				if (!this.participants.has(id)) {
					this.participants.set(id, new pygowave.model.Participant(id));
					this.new_participants.append(id);
				}
			}
		},
		
		/**
		 * Return all Participant objects with matching ID.
		 * @function {private pygowave.model.Participant[]} _getParticipants
		 * @param {String[]} id_list List of participant IDs
		 */
		_getParticipants: function (id_list) {
			var out = new Array();
			for (var it = new _Iterator(id_list);it.hasNext();) {
				var id = it.next();
				if (this.participants.has(id))
					out.append(this.participants[id]);
			}
			return out;
		},
		
		/**
		 * Requests information on participants from the server, which have not
		 * been retrieved yet. Reads from the new_participants array.
		 * @function {private} _requestParticipantInfo
		 * @param {String} wavelet_id ID of the Wavelet
		 */
		_requestParticipantInfo: function (wavelet_id) {
			if (this.new_participants.length == 0)
				return;
			
			this.conn.sendJson(wavelet_id, {
				type: "PARTICIPANT_INFO",
				property: this.new_participants
			});
			
			this.new_participants = new Array();
		},
		
		/**
		 * Callback from server after participant info request.
		 * @function {private} _processParticipantsInfo
		 * @param {Object} pmap Participants map
		 */
		_processParticipantsInfo: function (pmap) {
			for (var it = new _Iterator(pmap); it.hasNext(); ) {
				var pdata = it.next(), id = it.key();
				var i = this.new_participants.indexOf(id);
				if (i != -1)
					this.new_participants.pop(i);
				var obj;
				if (this.participants.has(id))
					obj = this.participants[id];
				else {
					obj = new pygowave.model.Participant(id);
					this.participants.set(id, obj);
				}
				obj.updateData(pdata);
			}
		},
		
		/**
		 * Setup two new OpManagers, one for pending and one for cached operations.
		 * Connect them to the controller using closures.
		 *
		 * @function {private} _setupOpManagers
		 * @param {String} wave_id ID of the Wave
		 * @param {String} wavelet_id ID of the Wavelet
		 */
		_setupOpManagers: function (wave_id, wavelet_id) {
			this.wavelets[wavelet_id].mpending = new pygowave.operations.OpManager(wave_id, wavelet_id);
			this.wavelets[wavelet_id].mcached = new pygowave.operations.OpManager(wave_id, wavelet_id);
			var self = this;
			this.wavelets[wavelet_id]._mcached_wrapper = function (start, end) {
				if (!self.hasPendingOperations(wavelet_id))
					self._transferOperations(wavelet_id);
			};
			this.wavelets[wavelet_id].mcached.addEvent('afterOperationsInserted', this.wavelets[wavelet_id]._mcached_wrapper);
		},
		/**
		 * Send ready made operations to the server.
		 *
		 * @function {private} _transferOperations
		 * @param {String} wavelet_id ID of the Wavelet
		 */
		_transferOperations: function (wavelet_id) {
			var mpending = this.wavelets[wavelet_id].mpending;
			var mcached = this.wavelets[wavelet_id].mcached;
			var model = this.wavelets[wavelet_id].model;
			
			if (mpending.isEmpty())
				mpending.put(mcached.fetch());
			
			if (!this.isBlocked(wavelet_id)) {
				this.wavelets[wavelet_id].pending = true;
				if ($defined(this._pendingTimer))
					$clear(this._pendingTimer);
				this._pendingTimer = this._serverAckTimeout.delay(10000, this);
				
				this.conn.sendJson(wavelet_id, {
					type: "OPERATION_MESSAGE_BUNDLE",
					property: {
						version: model.options.version,
						operations: mpending.serialize()
					}
				});
			}
		},
		_serverAckTimeout: function () {
			this._iview.showControllerError(gettext("The server did not acknowledge the last operation within 10 seconds. This could be a bug in the client or a server crash. Try to reload."));
		},
		/**
		 * Queue a message bundle if the view is busy. Process it, if it is or
		 * goes ready.
		 *
		 * @function {private} _queueMessageBundle
		 * @param {pygowave.model.Wavelet} wavelet Reference to a Wavelet model
		 * @param {Object[]} serial_ops Serialized operations
		 * @param {int} version New version after this bundle
		 * @param {Object} blipsums Checksums to compare the wavelet to
		 */
		_queueMessageBundle: function (wavelet, serial_ops, version, blipsums) {
			while (this._processingDeferred); // Busy waiting
			if (this._iview.isBusy()) {
				this._deferredMessageBundles.push({
					wavelet: wavelet,
					serial_ops: serial_ops,
					version: version,
					blipsums: blipsums
				});
			}
			else
				this._processMessageBundle(wavelet, serial_ops, version, blipsums);
		},
		/**
		 * Process a message bundle from the server. Do transformation and
		 * apply it to the model.
		 * 
		 * @function {private} _processOperations
		 * @param {pygowave.model.Wavelet} wavelet Wavelet model
		 * @param {Object[]} serial_ops Serialized operations
		 * @param {int} version New version after this bundle
		 * @param {Object} blipsums Checksums to compare the wavelet to
		 */
		_processMessageBundle: function (wavelet, serial_ops, version, blipsums) {
			var mpending = this.wavelets[wavelet.id()].mpending;
			var mcached = this.wavelets[wavelet.id()].mcached;
			
			if (serial_ops != "ACK") {
				var delta = new pygowave.operations.OpManager(wavelet.waveId(), wavelet.id());
				delta.unserialize(serial_ops);
				
				var ops = new Array();
				
				// Iterate over all operations
				for (var incoming = new _Iterator(delta.operations); incoming.hasNext(); ) {
					// Transform pending operations, iterate over results
					for (var tr = new _Iterator(mpending.transform(incoming.next())); tr.hasNext(); ) {
						// Transform cached operations, save results
						ops.extend(mcached.transform(tr.next()));
					}
				}
				
				// Apply operations
				wavelet.applyOperations(ops);
				
				// Set version and checkup
				wavelet.options.version = version;
				if (!this.hasPendingOperations(wavelet.id()))
					wavelet.checkSync(blipsums);
			}
			else { // ACK message
				$clear(this._pendingTimer);
				this._pendingTimer = null;
				wavelet.options.version = version;
				mpending.fetch(); // Clear
				if (!mcached.isEmpty())
					this._transferOperations(wavelet.id()); // Send cached
				else {
					// All done, we can do a check-up
					wavelet.checkSync(blipsums);
					this.wavelets[wavelet.id()].pending = false;
				}
			}
		},
		/**
		 * Callback from view if it goes ready.
		 *
		 * @function {private} _onViewReady
		 */
		_onViewReady: function () {
			if (this._deferredMessageBundles.length > 0 && !this._processingDeferred) {
				this._processingDeferred = true;
				for (var it = new _Iterator(this._deferredMessageBundles); it.hasNext(); ) {
					var bundle = it.next();
					this._processMessageBundle(bundle.wavelet, bundle.serial_ops, bundle.version, bundle.blipsums);
				}
				this._deferredMessageBundles.empty();
				this._processingDeferred = false;
			}
		},
		
		/**
		 * Callback from view on text insertion.<br/>
		 * Note: Does not generate an event in the model.
		 *
		 * @function {private} _onTextInserted
		 * @param {String} waveletId ID of the Wavelet
		 * @param {String} blipId ID of the Blip
		 * @param {int} index Start index of insertion
		 * @param {String} content Inserted content
		 */
		_onTextInserted: function (waveletId, blipId, index, content) {
			this.wavelets[waveletId].mcached.documentInsert(blipId, index, content);
			this.wavelets[waveletId].model.blipById(blipId).insertText(index, content, true);
		},
		/**
		 * Callback from view on text deletion.<br/>
		 * Note: Does not generate an event in the model.
		 *
		 * @event {private} _onTextDeleted
		 * @param {String} waveletId ID of the Wavelet
		 * @param {String} blipId ID of the Blip
		 * @param {int} start Start index of deletion
		 * @param {int} end End index of deletion
		 */
		_onTextDeleted: function (waveletId, blipId, start, end) {
			this.wavelets[waveletId].mcached.documentDelete(blipId, start, end);
			this.wavelets[waveletId].model.blipById(blipId).deleteText(start, end-start, true);
		},
		/**
		 * Callback from view on element insertion.<br/>
		 * Note: This generates an event in the model.
		 *
		 * @function {private} _onElementInsert
		 * @param {String} waveletId ID of the Wavelet
		 * @param {String} blipId ID of the Blip
		 * @param {int} index Position of the new element
		 * @param {String} type Element type
		 * @param {Object} properties Element properties
		 */
		_onElementInsert: function (waveletId, blipId, index, type, properties) {
			this.wavelets[waveletId].mcached.documentElementInsert(blipId, index, type, properties);
			this.wavelets[waveletId].model.blipById(blipId).insertElement(index, type, properties);
		},
		/**
		 * Callback from view on element deletion.<br/>
		 * Note: This generates an event in the model.
		 *
		 * @event {private} _onElementDelete
		 * @param {String} waveletId ID of the Wavelet
		 * @param {String} blipId ID of the Blip
		 * @param {int} index Position of the element to delete
		 */
		_onElementDelete: function (waveletId, blipId, index) {
			this.wavelets[waveletId].mcached.documentElementDelete(blipId, index);
			this.wavelets[waveletId].model.blipById(blipId).deleteElement(index, true);
		},
		/**
		 * Callback from view on element delta submission.
		 * 
		 * @param {String} waveletId ID of the Wavelet
		 * @param {String} blipId ID of the Blip
		 * @param {int} index Position of the element
		 * @param {Object} delta Delta to apply to the element
		 */
		_onElementDeltaSubmitted: function (waveletId, blipId, index, delta) {
			this.wavelets[waveletId].mcached.documentElementDelta(blipId, index, delta);
			this.wavelets[waveletId].model.blipById(blipId).applyElementDelta(index, delta);
		},
		/**
		 * Callback from view on element UserPref setting.
		 * 
		 * @param {String} waveletId ID of the Wavelet
		 * @param {String} blipId ID of the Blip
		 * @param {int} index Position of the element
		 * @param {Object} key Name of the UserPref
		 * @param {Object} value Value of the UserPref
		 */
		_onElementSetUserpref: function (waveletId, blipId, index, key, value) {
			this.wavelets[waveletId].mcached.documentElementSetpref(blipId, index, key, value);
			this.wavelets[waveletId].model.blipById(blipId).setElementUserpref(index, key, value, true);
		},
		/**
		 * Callback from view on searching.
		 *
		 * @function {private} _onSearchForParticipant
		 * @param {String} waveletId ID of the Wavelet
		 * @param {String} text Entered search query
		 */
		_onSearchForParticipant: function (waveletId, text) {
			this.conn.sendJson(waveletId, {
				type: "PARTICIPANT_SEARCH",
				property: text
			});
		},
		/**
		 * Callback from view on participant adding.
		 * @function {private} _onAddParticipant
		 * @param {String} waveletId ID of the Wavelet
		 * @param {String} participantId ID of the Participant to add
		 */
		_onAddParticipant: function (waveletId, participantId) {
			this.conn.sendJson(waveletId, {
				type: "WAVELET_ADD_PARTICIPANT",
				property: participantId
			});
		},
		/**
		 * Callback from view to leave the (root) wavelet.
		 * @function {private} _onLeaveWavelet
		 * @param {String} waveletId ID of the Wavelet
		 */
		_onLeaveWavelet: function (waveletId) {
			this.conn.sendJson(waveletId, {
				type: "WAVELET_REMOVE_SELF"
			});
		},
		/**
		 * Callback from view on gadget adding.
		 * @function {private} _onRefreshGadgetList
		 * @param {String} waveletId ID of the Wavelet
		 * @param {Boolean} forced True if the user explicitly clicked refresh
		 */
		_onRefreshGadgetList: function (waveletId, forced) {
			if (forced || this._cachedGadgetList == null) {
				this.conn.sendJson(waveletId, {
					type: "GADGET_LIST"
				});
			}
			else
				this._iview.updateGadgetList(this._cachedGadgetList);
		}
	});
	
	pygowave.controller.extend({
		PyGoWaveClient: PyGoWaveClient
	});
})();
