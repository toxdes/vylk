package note

type Note struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Filename  string `json:"filename"`
	Tags      string `json:"tags"`
	Pinned    bool   `json:"pinned"`
	PinOrder  int64  `json:"pin_order,omitempty"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Revision  int64  `json:"revision"`
}

type Page struct {
	Notes      []Note `json:"notes"`
	NextCursor string `json:"nextCursor,omitempty"`
}
