/**
 * @author Eberhard Graether / http://egraether.com/
 * @author Mark Lundin	 / http://mark-lundin.com
 */

var THREE = require('three');

var TrackballControls = function ( object, domElement ) {

	var _this = this;
	var STATE = { NONE: -1, ROTATE: 0, ZOOM: 1, PAN: 2, TOUCH_ROTATE: 3, TOUCH_ZOOM_PAN: 4 };

	this.object = object;

    // This controls object may be asked to feed information to a shader about the
    // viewport and the distance to the target.
    this.shaderMaterial = null;

	this.domElement = ( domElement !== undefined ) ? domElement : document;
    this.object.controls = this; // link controlled object to this controller; allow access to target vector...

	// API

	this.enabled = true;

	this.screen = { left: 0, top: 0, width: 0, height: 0 };

	// Note: rotateSpeed must be 2.0 to avoid hysteresis (so that dragging the
	// mouse around any closed path, no matter how vigorously, leaves the
	// rotation unchanged). Other values will cause the object's rotation to
	// drift counter-intuitively.
	// For a mathematical explanation, see Shoemake 1992: ARCBALL.
	this.rotateSpeed = 2.0;
	this.zoomSpeed = 1.2;
	this.panSpeed = 0.3;

	this.noRotate = false;
	this.noZoom = false;
	this.noPan = false;
	this.noRoll = false;

	// staticMoving must also be true to avoid hysteresis in the rotation gesture (see above).
	// Also disabling staticMoving makes the zoom/pan gestures almost unusable
	// since pythreejs doesn't call controls.update() with a timer.
	this.staticMoving = true;
	this.dynamicDampingFactor = 0.2;

	this.minDistance = 0;
	this.maxDistance = Infinity;

	this.keys = [ 65 /*A*/, 83 /*S*/, 68 /*D*/ ];

	// internals

	this.target = new THREE.Vector3();

	var EPS = 0.000001;

	var lastPosition = new THREE.Vector3();

	var _state = STATE.NONE,
		_prevState = STATE.NONE,

		_eye = new THREE.Vector3(),

		_rotateStart = new THREE.Vector3(),
		_rotateEnd = new THREE.Vector3(),

		_zoomStart = new THREE.Vector2(),
		_zoomEnd = new THREE.Vector2(),

		_touchZoomDistanceStart = 0,
		_touchZoomDistanceEnd = 0,

		_panStart = new THREE.Vector2(),
		_panEnd = new THREE.Vector2();

	// for reset

	this.target0 = this.target.clone();
	this.position0 = this.object.position.clone();
	this.up0 = this.object.up.clone();

	// events

	var changeEvent = { type: 'change' };
	var startEvent = { type: 'start'};
	var endEvent = { type: 'end'};

	// methods

	// Note: this method must be called not only when the canvas is resized, but also
	// when the page is scrolled! Instead of using it as a callback, we just
	// update the bounds whenever a mouse/touch interaction begins.
	this.updateBounds = function () {

		if ( this.domElement === document ) {

			this.screen.left = 0;
			this.screen.top = 0;
			this.screen.width = window.innerWidth;
			this.screen.height = window.innerHeight;

		} else {

			var box = this.domElement.getBoundingClientRect();
			// adjustments come from similar code in the jquery offset() function
			var d = this.domElement.ownerDocument.documentElement;
			this.screen.left = box.left + window.pageXOffset - d.clientLeft;
			this.screen.top = box.top + window.pageYOffset - d.clientTop;
			this.screen.width = box.width;
			this.screen.height = box.height;

		}

        if (_this.shaderMaterial) {
            if (this.screen.width != _this.shaderMaterial.uniforms.rendererWidth.value) {
                _this.shaderMaterial.uniforms.rendererWidth.value = this.screen.width;
                _this.shaderMaterial.needsUpdate = true;
            }
        }
	};

    // This callback will be called from RenderableView::updateSize
    // in 'js/src/_base/Renderable.js'
    this.handleResize = function() { this.updateBounds(); };

	var getMouseOnScreen = ( function () {

		var vector = new THREE.Vector2();

		return function ( pageX, pageY ) {

			vector.set(
				( pageX - _this.screen.left ) / _this.screen.width,
				( pageY - _this.screen.top ) / _this.screen.height
			);

			return vector;

		};

	}() );

	var getMouseProjectionOnBall = ( function () {

		var vector = new THREE.Vector3();
		var objectUp = new THREE.Vector3();
		var mouseOnBall = new THREE.Vector3();

		return function ( pageX, pageY ) {
			mouseOnBall.set(
				( pageX - _this.screen.width * 0.5 - _this.screen.left ) / (_this.screen.width*.5),
				( _this.screen.height * 0.5 + _this.screen.top - pageY ) / (_this.screen.height*.5),
				0.0
			);

			var length = mouseOnBall.length();

			if ( _this.noRoll ) {

				if ( length < Math.SQRT1_2 ) {

					mouseOnBall.z = Math.sqrt( 1.0 - length*length );

				} else {

					mouseOnBall.z = .5 / length;

				}

			} else if ( length > 1.0 ) {

				mouseOnBall.normalize();

			} else {

				mouseOnBall.z = Math.sqrt( 1.0 - length * length );

			}

			_eye.copy( _this.object.position ).sub( _this.target );

			vector.copy( _this.object.up ).setLength( mouseOnBall.y );
			vector.add( objectUp.copy( _this.object.up ).cross( _eye ).setLength( mouseOnBall.x ) );
			vector.add( _eye.setLength( mouseOnBall.z ) );

			return vector;

		};

	}() );

	this.rotateCamera = (function (){

		var axis = new THREE.Vector3(),
			quaternion = new THREE.Quaternion();


		return function () {

			var angle = Math.acos( _rotateStart.dot( _rotateEnd ) / _rotateStart.length() / _rotateEnd.length() );

			if ( angle ) {

				axis.crossVectors( _rotateStart, _rotateEnd ).normalize();

				angle *= _this.rotateSpeed;

				quaternion.setFromAxisAngle( axis, -angle );

				_eye.applyQuaternion( quaternion );
				_this.object.up.applyQuaternion( quaternion );

				_rotateEnd.applyQuaternion( quaternion );

				if ( _this.staticMoving ) {

					_rotateStart.copy( _rotateEnd );

				} else {

					quaternion.setFromAxisAngle( axis, angle * ( _this.dynamicDampingFactor - 1.0 ) );
					_rotateStart.applyQuaternion( quaternion );

				}

			}
		};

	}());

	this.zoomCamera = function () {

		if ( _state === STATE.TOUCH_ZOOM_PAN ) {

			var factor = _touchZoomDistanceStart / _touchZoomDistanceEnd;
			_touchZoomDistanceStart = _touchZoomDistanceEnd;
			_eye.multiplyScalar( factor );

		} else {

			var factor = 1.0 + ( _zoomEnd.y - _zoomStart.y ) * _this.zoomSpeed;

			if ( factor !== 1.0 && factor > 0.0 ) {

				_eye.multiplyScalar( factor );

				if ( _this.staticMoving ) {

					_zoomStart.copy( _zoomEnd );

				} else {

					_zoomStart.y += ( _zoomEnd.y - _zoomStart.y ) * this.dynamicDampingFactor;

				}

			}

		}

	};

	this.panCamera = (function (){

		var mouseChange = new THREE.Vector2(),
			objectUp = new THREE.Vector3(),
			pan = new THREE.Vector3();

		return function () {

			mouseChange.copy( _panEnd ).sub( _panStart );

			if ( mouseChange.lengthSq() ) {

				mouseChange.multiplyScalar( _eye.length() * _this.panSpeed );

				pan.copy( _eye ).cross( _this.object.up ).setLength( mouseChange.x );
				pan.add( objectUp.copy( _this.object.up ).setLength( mouseChange.y ) );

				_this.object.position.add( pan );
				_this.target.add( pan );

				if ( _this.staticMoving ) {

					_panStart.copy( _panEnd );

				} else {

					_panStart.add( mouseChange.subVectors( _panEnd, _panStart ).multiplyScalar( _this.dynamicDampingFactor ) );

				}

			}
		};

	}());

	this.checkDistances = function () {

		if ( !_this.noZoom || !_this.noPan ) {

			if ( _eye.lengthSq() > _this.maxDistance * _this.maxDistance ) {

				_this.object.position.addVectors( _this.target, _eye.setLength( _this.maxDistance ) );

			}

			if ( _eye.lengthSq() < _this.minDistance * _this.minDistance ) {

				_this.object.position.addVectors( _this.target, _eye.setLength( _this.minDistance ) );

			}

		}

	};

	this.update = function () {
		_eye.subVectors( _this.object.position, _this.target );

		if ( !_this.noRotate ) {

			_this.rotateCamera();

		}

		if ( !_this.noZoom ) {

			_this.zoomCamera();

		}

		if ( !_this.noPan ) {

			_this.panCamera();

		}

		_this.object.position.addVectors( _this.target, _eye );

		_this.checkDistances();

		_this.object.lookAt( _this.target );

		if ( lastPosition.distanceToSquared( _this.object.position ) > EPS ) {

			_this.dispatchEvent( changeEvent );

			lastPosition.copy( _this.object.position );

		}

        if (_this.shaderMaterial) {
            v = new THREE.Vector3(),
			v.copy( _this.object.position ).sub( _this.target );
            _this.shaderMaterial.uniforms.targetDepth.value = v.length();
            _this.shaderMaterial.needsUpdate = true;
        }
	};

	this.reset = function () {

		_state = STATE.NONE;
		_prevState = STATE.NONE;

		_this.target.copy( _this.target0 );
		_this.object.position.copy( _this.position0 );
		_this.object.up.copy( _this.up0 );

		_eye.subVectors( _this.object.position, _this.target );

		_this.object.lookAt( _this.target );

		_this.dispatchEvent( changeEvent );

		lastPosition.copy( _this.object.position );

	};

	this.connectEvents = function (element) {
		if (element) {
			_this.domElement = element;
		}
		_this.domElement.addEventListener( 'contextmenu', contextmenu, false );

		_this.domElement.addEventListener( 'mousedown', mousedown, false );
		_this.domElement.addEventListener( 'mousewheel', mousewheel, { passive: false } );
		_this.domElement.addEventListener( 'MozMousePixelScroll', mousewheel, { passive: false } ); // firefox

		_this.domElement.addEventListener( 'touchstart', touchstart, { passive: true } );
		_this.domElement.addEventListener( 'touchend', touchend, false );
		_this.domElement.addEventListener( 'touchmove', touchmove, { passive: false} );

		_this.domElement.addEventListener( 'keydown', keydown, false );
		_this.domElement.addEventListener( 'keyup', keyup, false );
	};

	this.dispose = function () {

		_this.domElement.removeEventListener( 'contextmenu', contextmenu, false );

		_this.domElement.removeEventListener( 'mousedown', mousedown, false );

		_this.domElement.removeEventListener( 'mousewheel', mousewheel, { passive: false } );
		_this.domElement.removeEventListener( 'MozMousePixelScroll', mousewheel, { passive: false } ); // firefox

		_this.domElement.removeEventListener( 'touchstart', touchstart, false );
		_this.domElement.removeEventListener( 'touchend', touchend, false );
		_this.domElement.removeEventListener( 'touchmove', touchmove, false );

		document.removeEventListener( 'mousemove', mousemove, false );
		document.removeEventListener( 'mouseup', mouseup, false );

		_this.domElement.removeEventListener( 'keydown', keydown, false );
		_this.domElement.removeEventListener( 'keyup', keyup, false );

		//_this.dispatchEvent( { type: 'dispose' } ); // should this be added here?

	};

	// listeners

	function contextmenu( event ) {
		event.preventDefault();
	}

	function keydown( event ) {

		if ( _this.enabled === false ) return;

		window.removeEventListener( 'keydown', keydown );

		_prevState = _state;

		if ( _state !== STATE.NONE ) {

			return;

		} else if ( event.keyCode === _this.keys[ STATE.ROTATE ] && !_this.noRotate ) {

			_state = STATE.ROTATE;

		} else if ( event.keyCode === _this.keys[ STATE.ZOOM ] && !_this.noZoom ) {

			_state = STATE.ZOOM;

		} else if ( event.keyCode === _this.keys[ STATE.PAN ] && !_this.noPan ) {

			_state = STATE.PAN;

		}

	}

	function keyup( event ) {

		if ( _this.enabled === false ) return;

		_state = _prevState;

		window.addEventListener( 'keydown', keydown, false );

	}

	function mousedown( event ) {

		if ( _this.enabled === false ) return;

		// Make sure we know the current canvas bounds so that
		// mouse coordinates are computed properly during this interaction.
		_this.updateBounds();

		event.preventDefault();
		event.stopPropagation();

		if ( _state === STATE.NONE ) {

			_state = event.button;

		}

		if ( _state === STATE.ROTATE && !_this.noRotate ) {

			_rotateStart.copy( getMouseProjectionOnBall( event.pageX, event.pageY ) );
			_rotateEnd.copy( _rotateStart );

		} else if ( _state === STATE.ZOOM && !_this.noZoom ) {

			_zoomStart.copy( getMouseOnScreen( event.pageX, event.pageY ) );
			_zoomEnd.copy(_zoomStart);

		} else if ( _state === STATE.PAN && !_this.noPan ) {

			_panStart.copy( getMouseOnScreen( event.pageX, event.pageY ) );
			_panEnd.copy(_panStart);

		}

		document.addEventListener( 'mousemove', mousemove, false );
		document.addEventListener( 'mouseup', mouseup, false );

		_this.dispatchEvent( startEvent );

	}

	function mousemove( event ) {

		if ( _this.enabled === false ) return;

		event.preventDefault();
		event.stopPropagation();

		if ( _state === STATE.ROTATE && !_this.noRotate ) {

			_rotateEnd.copy( getMouseProjectionOnBall( event.pageX, event.pageY ) );

		} else if ( _state === STATE.ZOOM && !_this.noZoom ) {

			_zoomEnd.copy( getMouseOnScreen( event.pageX, event.pageY ) );

		} else if ( _state === STATE.PAN && !_this.noPan ) {

			_panEnd.copy( getMouseOnScreen( event.pageX, event.pageY ) );

		}

		_this.update();

	}

	function mouseup( event ) {

		if ( _this.enabled === false ) return;

		event.preventDefault();
		event.stopPropagation();

		_this.update();

		_state = STATE.NONE;

		document.removeEventListener( 'mousemove', mousemove );
		document.removeEventListener( 'mouseup', mouseup );
		_this.dispatchEvent( endEvent );

	}

	function mousewheel( event ) {
		if ( _this.enabled === false ) return;

		if ( _this.noZoom === true ) return;

		event.preventDefault();
		event.stopPropagation();

		_this.dispatchEvent( startEvent );

		var delta = 0;

		if ( event.wheelDelta ) { // WebKit / Opera / Explorer 9

			delta = event.wheelDelta / 40;

		} else if ( event.detail ) { // Firefox

			delta = - event.detail / 3;

		}

		_zoomStart.y += delta * 0.01;
		_this.update();

		_this.dispatchEvent( endEvent );

	}

	function touchstart( event ) {
		if ( _this.enabled === false ) return;

		// Make sure we know the current canvas bounds so that
		// mouse coordinates are computed properly during this interaction.
		_this.updateBounds();

		event.preventDefault();
        event.stopPropagation();

		switch ( event.touches.length ) {
            case 1:
                _state = STATE.TOUCH_ROTATE;
                _rotateStart.copy( getMouseProjectionOnBall( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY ) );
                _rotateEnd.copy( _rotateStart );
                break;

            case 2:
                _state = STATE.TOUCH_ZOOM_PAN;
                var p1 = getMouseOnScreen(event.touches[0].pageX, event.touches[0].pageY);
                var p2 = getMouseOnScreen(event.touches[1].pageX, event.touches[1].pageY);

                var vector = new THREE.Vector2();
                vector.subVectors(p1, p2);

                var dx = event.touches[ 0 ].pageX - event.touches[ 1 ].pageX;
                var dy = event.touches[ 0 ].pageY - event.touches[ 1 ].pageY;
                _touchZoomDistanceEnd = _touchZoomDistanceStart = Math.sqrt( dx * dx + dy * dy );
                // _touchZoomDistanceEnd = _touchZoomDistanceStart = vector.length();

                vector.addVectors(p1, p2);
                vector.multiplyScalar(0.5);
                _panStart.copy(vector);
                _panEnd.copy(vector);
                break

            default:
                _state = STATE.NONE;
		}

		_this.dispatchEvent( startEvent );
	}

	function touchmove( event ) {
		if ( _this.enabled === false ) return;

		event.preventDefault();
		event.stopPropagation();

		switch ( event.touches.length ) {
            case 1:
                _rotateEnd.copy( getMouseProjectionOnBall( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY ) );
                break;

            case 2:
                var p1 = getMouseOnScreen(event.touches[0].pageX, event.touches[0].pageY);
                var p2 = getMouseOnScreen(event.touches[1].pageX, event.touches[1].pageY);

                var vector = new THREE.Vector2();
                vector.subVectors(p1, p2);

                var dx = event.touches[ 0 ].pageX - event.touches[ 1 ].pageX;
                var dy = event.touches[ 0 ].pageY - event.touches[ 1 ].pageY;
                _touchZoomDistanceEnd = Math.sqrt( dx * dx + dy * dy );
                // _touchZoomDistanceEnd = vector.length();

                vector.addVectors(p1, p2);
                vector.multiplyScalar(0.5);
                _panEnd.copy(vector);
                break;

            default:
                _state = STATE.NONE;
		}

		_this.update();
	}

	function touchend( event ) {

		if ( _this.enabled === false ) return;

		event.preventDefault();
		event.stopPropagation();

		_this.update();

		_state = STATE.NONE;
		_this.dispatchEvent( endEvent );
	}

	this.connectEvents();

	this.updateBounds();

	// force an update at start
	this.update();

};

TrackballControls.prototype = Object.create( THREE.EventDispatcher.prototype );
TrackballControls.prototype.constructor = TrackballControls;

module.exports = {
	TrackballControls: TrackballControls
};
