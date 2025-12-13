(function() {
    function refreshTimeLabels() {
        const now = Math.floor(Date.now() / 1000)
        for (const element of document.getElementsByClassName('time')) {
            let t = 0
            if (element.getAttribute('data-time')) {
                t = Number.parseInt(String(element.getAttribute('data-time')))
            } else {
                t = Math.floor(Date.parse(element.textContent) / 1000)
                element.setAttribute('data-time', t)
            }
            let d = now - t
            if (d < 60) {
                element.textContent = `${d} másodperce`
                continue
            }
            d = Math.floor(d / 60)
            if (d < 60) {
                element.textContent = `${d} perce`
                continue
            }
            d = Math.floor(d / 60)
            if (d < 24) {
                element.textContent = `${d} órája`
                continue
            }
            const date = new Date(t * 1000)
            element.textContent = `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}. ${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
        }
    }

    setInterval(refreshTimeLabels, 5000)
    refreshTimeLabels()

    const vscode = acquireVsCodeApi()

    for (const element of document.getElementsByClassName('file-link')) {
        element.addEventListener('click', () => {
            vscode.postMessage({
                command: 'open-file',
                filename: element.getAttribute('data-filename'),
                submissionId: Number(element.getAttribute('data-submission')),
            })
        })
    }
})()
