
var readAloudDoc = location.pathname.startsWith("/sample/") ? new KindleSample() : new KindleBook()


//full books render pages as images, reading them needs OCR which is not available
function KindleBook() {
  this.getCurrentIndex = function() {
    throw new Error(JSON.stringify({code: "error_page_unreadable"}))
  }

  this.getTexts = function(index) {
    return null
  }
}


function KindleSample() {
  this.getCurrentIndex = function() {
    return 0
  }

  this.getTexts = function(index) {
    return index == 0 ? getTexts() : null
  }

  function getTexts() {
    const elems = $("#kr-renderer").find("div[data-pid]").get()
      .filter(el => el.firstChild && el.firstChild.tagName != "DIV")
    const index = elems.findIndex(el => el.getBoundingClientRect().top > 100)
    return elems.slice(index)
      .map(getInnerText)
      .filter(text => /[\p{L}\p{Nl}\p{Nd}]/u.test(text))
  }
}
