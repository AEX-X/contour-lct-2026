# ML data

Эта папка предназначена только для локального подготовленного журнала ML:

```text
2019.parquet
2020.parquet
2021.parquet
2022.parquet
2023.parquet
2024.parquet
2025.parquet
2026.parquet
```

Файлы Parquet не копируются в Docker image и не попадают в Git. Они подключаются к контейнеру `ml` только для чтения. Перед полным запуском `scripts/start-full.ps1` проверяет наличие всех восьми файлов и сигнатуру Parquet `PAR1`
