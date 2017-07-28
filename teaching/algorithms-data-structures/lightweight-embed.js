/* Light YouTube Embeds by @labnol */
/* Web: http://labnol.org/?p=27941 */

document.addEventListener("DOMContentLoaded",
	function() {
		var div, n,
			v = document.getElementsByClassName("youtube-player");
		for (n = 0; n < v.length; n++) {
			div = document.createElement("div");
			div.setAttribute("data-id", v[n].dataset.id);
			if (v[n].hasAttribute("data-opts")) {
				div.setAttribute("data-opts", "&" + v[n].dataset.opts);
			} else {
				div.setAttribute("data-opts", "");
			}
			div.innerHTML = labnolThumb(v[n].dataset.id);
			div.onclick = labnolIframe;
			v[n].appendChild(div);
		}
	});

function labnolThumb(id) {
	var thumb = '<img src="https://i.ytimg.com/vi/ID/hqdefault.jpg"/>',
		play = '<div class="play"></div>';
	return thumb.replace("ID", id) + play;
}

function labnolIframe() {
	var iframe = document.createElement("iframe");
	var embed = "https://www.youtube.com/embed/ID?autoplay=1&rel=0ADDITIONALOPTIONS";
	iframe.setAttribute("src", embed.replace("ID", this.dataset.id).
		replace("ADDITIONALOPTIONS", this.dataset.opts));
	iframe.setAttribute("frameborder", "0");
	iframe.setAttribute("allowfullscreen", "1");
	this.parentNode.replaceChild(iframe, this);
}
