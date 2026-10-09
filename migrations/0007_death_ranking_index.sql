-- Ranking cache misses only read deaths inside the rolling 24-hour window.
CREATE INDEX idx_deaths_date ON deaths(date);
