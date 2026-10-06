class CoreError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Core:
    id = ""
    name = ""
    description = ""
    link_re = ""
    placeholder = "Search by title or paste a link"

    def public(self):
        return {
            "id": self.id,
            "name": self.name or self.id,
            "description": self.description,
            "link": self.link_re,
            "placeholder": self.placeholder,
        }

    def search(self, query):
        raise CoreError("This source has no search.", 501)

    def info(self, query):
        raise CoreError("This source has no book info.", 501)

    def build(self, job, data, out_dir):
        raise CoreError("This source cannot build an EPUB.", 501)
