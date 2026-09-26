
//PDF pages (js/content.js getRequireJs) can't be read: there is no PDF viewer to extract their text.
//A selection is still read (js/content.js getCurrentIndex asks for it first)
var readAloudDoc = new function() {
  function unreadable() {
    return Promise.reject(new Error(JSON.stringify({code: "error_page_unreadable"})))
  }
  this.getCurrentIndex = unreadable
  this.getTexts = unreadable
}
