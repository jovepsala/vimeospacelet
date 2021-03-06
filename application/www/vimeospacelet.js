var control_size;
var injectURL = "";
var controls = {};
var spaceletRPC = null;
var bigscreenRPC = null;
var bManualSeeking = false;
var bFirstConnection = true;
var unique_name = "spaceify/vimeospacelet";

var RECONNECT_TIMEOUT = 10;

/**
 * DOM * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */
window.addEventListener("load", function()
{
	if(document.getElementById("[data-ajax-list]") != null)													// Catch mobile versions "load more content" event (!DOMSubtreeModified)
		document.getElementById("[data-ajax-list]").addEventListener("DOMNodeInserted", moreVideosLoaded, false);

	connect();
});

/**
 * RPC CONNECTION  * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */
function connect()
{
	// Start the spacelet - returns the bigscreen command service
	$SC.startSpacelet(unique_name, "spaceify.org/services/vimeo_command", false, function(err, data)
	{
		if(err)
		{
			initialize(false, vsLanguage.formatErrorString("connect:startSpacelet:", err));
			close();
		}
		else
		{
			bigscreenRPC = data;
			bigscreenRPC.exposeRPCMethod("pageReady", self, pageReady);
			bigscreenRPC.exposeRPCMethod("close", self, close);							// close originates from the jsapp when all the bigscreens are closed or from connection class when connection is lost
			bigscreenRPC.setCloseEventListener(close);

			injectURL = $SN.getApplicationWebServerURL(unique_name);					// spacelets internal web server provides the images etc.

			// Start the vimeo command service
			spaceletRPC = new SpaceifyRPC($SS.getService("spaceify.org/services/vimeo_frontend", unique_name), false, function(err, data)
			{
				if(err)
				{
					initialize(false, vsLanguage.formatErrorString("connect::RPC:", err));
					close();
				}
				else
				{
					spaceletRPC.exposeRPCMethod("videoReady", self, videoReady);
					spaceletRPC.exposeRPCMethod("videoPlay", self, videoPlay);
					spaceletRPC.exposeRPCMethod("videoPause", self, videoPause);
					spaceletRPC.exposeRPCMethod("videoSeek", self, videoSeek);
					spaceletRPC.exposeRPCMethod("videoFinish", self, videoFinish);
					spaceletRPC.exposeRPCMethod("videoProgress", self, videoProgress);
					spaceletRPC.setCloseEventListener(close);							// monitor connection
				}

				if(bFirstConnection) {													// If this is the first connection attempt, find the videos
					findVideoDivs(); bFirstConnection = false; }
			});
		}
	});
}

/**
 * EXPOSED BIGSCREEN RPC METHODS * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */
function pageReady(source, content, initialized)
{ // Some page, vimeospacelet or other, is now loaded. If vimeo is loaded the content is the video_id passed to bigscreenRPC::showContent.
	initialize((source == "vimeo" ? initialized : false));

	return true;
}

function close(isInternal)
{
	initialize(false);

	if(spaceletRPC)
	{
		spaceletRPC.close();
		spaceletRPC = null;
	}

	if(bigscreenRPC)
	{
		bigscreenRPC.close();
		bigscreenRPC = null;
	}

	window.setTimeout(connect, RECONNECT_TIMEOUT * 1000);								// Try to reconnect
}

/**
 * EVENTS FROM THE INJECTED CONTROLS * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */
function playPauseVideo(video_id)
{
	vURL = ":" + $SN.getApplicationWebServerPort(unique_name) + "/vimeospacelet.html";

	if((control = getControl(video_id)) == null)
		return initialize(false, vsLanguage.E_UNKNOWN_VIDEO_ID);

	if(!bigscreenRPC)
		return initialize(false, vsLanguage.E_NO_CONNECTION);

	if(control.playButton.nowPlaying)												// Call videoPause/videoPlay to show the video
		bigscreenRPC.call("showContent", ["vimeo", vURL, video_id, "videoPause", $SN.isSecure()], null, null);
	else
	{
		control.infoText.nodeValue = setInfoText(vsLanguage.WAITING);
		bigscreenRPC.call("showContent", ["vimeo", vURL, video_id, "videoPlay", $SN.isSecure()], null, null);
	}
	resetControls(control.playButton.id);
}

function seekVideo(video_id)
{
	if((control = getControl(video_id)) == null || !spaceletRPC || !bigscreenRPC)
		return;

	bManualSeeking = true;
	spaceletRPC.call("videoSeek", [video_id, control.range.value], self, function(err, data)
	{
		bManualSeeking = false;

		if(err)
			initialize(false, err);
	});
}

/**
 * EXPOSED SPACELET RPC METHODS  * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */
function videoReady(video_id, durationSeconds)								// Called after a new video is loaded to the bigscreen iframe
{
	if((control = getControl(video_id)) != null)
	{
		control.range.value = 0;
		control.range.min = 0;
		control.range.max = durationSeconds;

		resetControls(control.playButton.id);
	}
	else
		setInitialized(false);
}

function videoPlay(video_id)
{
	if((control = getControl(video_id)) != null)
		playState(control);
}

function videoPause(video_id)
{
	if((control = getControl(video_id)) != null)
	{
		control.infoText.nodeValue = setInfoText(vsLanguage.PAUSED);
		pauseState(control);
	}
}

function videoProgress(video_id, pps, durationSeconds)
{
	if(!bManualSeeking && (control = getControl(video_id)) != null && spaceletRPC && bigscreenRPC)
	{
		if(control.range.max == 0)											// Just in case... (eg. video paused, browser refreshed and same video played again -> bigscreen continues paused video when video_id remains the same)
			control.range.max = durationSeconds;

		control.range.value = Math.min(pps, durationSeconds);
		control.infoText.nodeValue = setInfoText(formatTime(pps));

		// Video id found and video is not in the play state -> set video to play state. 
		// This can happen, for example, if client is not the one who set the video playing, and just 
		// happens to be on a page which has the video that is already playing on the big screen.
		if(!control.playButton.nowPlaying)
		{
			resetControls();
			playState(control);
		}
	}
}

function videoFinish(video_id)
{
	if((control = getControl(video_id)) != null)
		pauseState(control);
}

function videoSeek(video_id, pps, durationSeconds)
{
	videoProgress(video_id, pps, durationSeconds);
}

/**
 * COMMON FUNCTIONS  * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */
function findVideoDivs()
{
	console.log("findVideoDivs() called");
	var regx = /^player.*/i
	var divs = document.getElementsByTagName("div");
	for(di in divs)
	{
		if(divs[di].className && (divs[di].className.search("player_container")!=-1 || divs[di].className.search("player_wrapper")!=-1))
		{
			console.log("player_container found");
			var holder = divs[di];

			nodes = holder.childNodes;//getElementsByTagName("div");
			for(var ni=0; ni < nodes.length; ni++)
			{
				var player = nodes[ni];
				console.log(player.tagName);
				if(typeof PlayerManager !== "undefined" && player.tagName == "DIV" && player.className && regx.test(player.className))	// desktop
				{
					console.log("desktop player found");
					addControls(holder, PlayerManager.getPlayer(player).videoId, false);
					break;
				}

				if(player.tagName == "DIV" && player.getAttribute("data-clip-id")) 				// mobile
				{
					console.log("mobile player found");
					addControls(holder, player.getAttribute("data-clip-id"), true);
					break;
				}
			}
		}
	}	
}

function moreVideosLoaded(event)
{
	var cn = event.target.childNodes;															// li.childNodes
	for(i in cn)
	{
		if(cn[i].className == "player_wrapper")
		{
			addControls(cn[i], event.target.id.replace("video_", ""), true);
			break;
		}
	}
}

function addControls(holder, video_id, mobile)
{
	if(getControl(video_id) != null)															// don't add duplicate controls
		return;

	control_size = (mobile ? "48" : "64");

	holder.parentNode.style.backgroundColor = "transparent";
	var hw = parseInt(holder.parentNode.offsetWidth);
	var cw = parseInt(control_size);

	// Position: input range
	var range = document.createElement("input");
	range.type = "range";
	range.id = "range_" + video_id;
	range.value = "0";
	range.min = 0;
	range.max = 0;
	range.onchange = function() { seekVideo(video_id); };
	//range.oninput = function() { seekVideo(video_id); };
	range.className = "vs_bsrange";
	range.style.height = control_size + "px";
	range.style.width = (hw - (cw + 4 * 10)) + "px";

	// Play: input image
	var playButton = document.createElement("input");
	playButton.type = "image";
	playButton.id = "playButton_" + video_id;
	playButton.alt = "";
	playButton.src = injectURL + "/play" + control_size + ".png";
	playButton.width = control_size;
	playButton.height = control_size;
	playButton.style.width = control_size + "px";
	playButton.style.height = control_size + "px";
	playButton.className = "vs_pbutton";
	playButton.nowPlaying = false;
	playButton.onclick = function() { playPauseVideo(video_id, false); };

	// Info: text node inside a div
	var infoDiv = document.createElement("div");
	infoDiv.className = "vs_infotext";
	var infoText = document.createTextNode(vsLanguage.INFO_TITLE);
	infoDiv.appendChild(infoText);

	// Controls: div
	var controlsDiv = document.createElement("div");
	controlsDiv.className = "vs_controlsdiv";

	controlsDiv.appendChild(playButton);
	controlsDiv.appendChild(range);

	// Container: div
	var containerDiv = document.createElement("div");
	containerDiv.id = "cdiv_" + video_id;
	containerDiv.className = "vs_containerdiv";
	containerDiv.style.fontSize = (mobile ? "24px" : "32px");

	containerDiv.appendChild(infoDiv);
	containerDiv.appendChild(controlsDiv);

	// Add to holder
	holder.parentNode.insertBefore(containerDiv, holder.nextSibling);

	// Store controls
	var control = {};
	control.container = containerDiv;
	control.controls = controlsDiv;
	control.range = range;
	control.playButton = playButton;
	control.infoText = infoText;
	controls[video_id] = control;
}

function getControl(video_id)
{
	if(video_id in controls)
		return controls[video_id];

	return null;
}

function playState(control)
{
	control.playButton.nowPlaying = true;
	control.playButton.src = injectURL + "/pause" + control_size + ".png";
}

function pauseState(control)
{
	control.playButton.nowPlaying = false;
	control.playButton.src = injectURL + "/play" + control_size + ".png";
}

function resetControls(eid)
{
	for(ci in controls)
	{
		if(controls[ci].playButton.id != eid)
		{
			controls[ci].playButton.nowPlaying = false;
			controls[ci].playButton.src = injectURL + "/play" + control_size + ".png";

			controls[ci].range.min = 0;
			controls[ci].range.max = 0;
			controls[ci].range.value = 0;
			controls[ci].infoText.nodeValue = setInfoText("");
		}
	}
}

function formatTime(pps)
{
	var sec = pps % 60;
	var tmp = (pps - sec) / 60;
	var min = tmp % 60;
	var hrs = (tmp - min) / 60;

	return (hrs < 10 ? "0" + hrs : hrs) + vsLanguage.TIME_SEP + (min < 10 ? "0" + min : min) + vsLanguage.TIME_SEP + (sec < 10 ? "0" + sec : sec);
}

function initialize(status, errstr)
{
	if(errstr)
	{
		//alert(errstr);
		console.log(errstr);
	}

	resetControls("");
}

function setInfoText(str)
{
	return vsLanguage.INFO_TITLE + (str != "" ? vsLanguage.TITLE_SEP + str : "");
}
