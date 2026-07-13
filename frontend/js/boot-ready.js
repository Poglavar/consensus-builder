// Marks the end of app bootstrap. This is the LAST script in index.html's load list: once it
// runs, every inline onclick handler exists, so the CSS boot gate (body.app-loading keeps the
// always-visible chrome inert) can be lifted. Loaded scripts are independent tags, so an error
// in an earlier file cannot stop this one from running and wedging the UI shut.
document.body.classList.remove('app-loading');
