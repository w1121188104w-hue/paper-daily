# 19刊身份核验表

本表解释“程序认的是哪本期刊”，不表示论文收录率达到100%。

2026-09-03：逐刊核对 OpenAlex Sources API 的刊名、source ID、ISSN 集合，并核对 Crossref Journals API 的刊名和返回的 ISSN。
2026-09-07：补充查询 ISSN Portal，确认 AOS、JAE、JFE、JCF、RP 五刊电子 ISSN 的 Online 介质身份。API和登记记录均可能后续修订。

配置文件为 `data/config/journals.json`。下表的 OpenAlex ID 和 Crossref ISSN 链接直达官方记录。

| key | 期刊全名 | 分组 | 印刷 ISSN | 电子 ISSN | OpenAlex source ID | Crossref 查询 ISSN |
| --- | --- | --- | --- | --- | --- | --- |
| TAR | The Accounting Review | 会计 | 0001-4826 | 1558-7967 | [S160506855](https://api.openalex.org/sources/S160506855) | [0001-4826](https://api.crossref.org/journals/0001-4826) |
| AOS | Accounting, Organizations and Society | 会计 | 0361-3682 | 1873-6289 | [S198892436](https://api.openalex.org/sources/S198892436) | [0361-3682](https://api.crossref.org/journals/0361-3682) |
| JAR | Journal of Accounting Research | 会计 | 0021-8456 | 1475-679X | [S111116695](https://api.openalex.org/sources/S111116695) | [0021-8456](https://api.crossref.org/journals/0021-8456) |
| JAE | Journal of Accounting and Economics | 会计 | 0165-4101 | 1879-1980 | [S62142384](https://api.openalex.org/sources/S62142384) | [0165-4101](https://api.crossref.org/journals/0165-4101) |
| CAR | Contemporary Accounting Research | 会计 | 0823-9150 | 1911-3846 | [S65924262](https://api.openalex.org/sources/S65924262) | [0823-9150](https://api.crossref.org/journals/0823-9150) |
| RAS | Review of Accounting Studies | 会计 | 1380-6653 | 1573-7136 | [S11853582](https://api.openalex.org/sources/S11853582) | [1380-6653](https://api.crossref.org/journals/1380-6653) |
| AER | American Economic Review | 经济 | 0002-8282 | 1944-7981 | [S23254222](https://api.openalex.org/sources/S23254222) | [0002-8282](https://api.crossref.org/journals/0002-8282) |
| JPE | Journal of Political Economy | 经济 | 0022-3808 | 1537-534X | [S95323914](https://api.openalex.org/sources/S95323914) | [0022-3808](https://api.crossref.org/journals/0022-3808) |
| QJE | The Quarterly Journal of Economics | 经济 | 0033-5533 | 1531-4650 | [S203860005](https://api.openalex.org/sources/S203860005) | [0033-5533](https://api.crossref.org/journals/0033-5533) |
| RES | The Review of Economic Studies | 经济 | 0034-6527 | 1467-937X | [S88935262](https://api.openalex.org/sources/S88935262) | [0034-6527](https://api.crossref.org/journals/0034-6527) |
| JF | The Journal of Finance | 金融 | 0022-1082 | 1540-6261 | [S5353659](https://api.openalex.org/sources/S5353659) | [0022-1082](https://api.crossref.org/journals/0022-1082) |
| JFE | Journal of Financial Economics | 金融 | 0304-405X | 1879-2774 | [S149240962](https://api.openalex.org/sources/S149240962) | [0304-405X](https://api.crossref.org/journals/0304-405X) |
| RFS | The Review of Financial Studies | 金融 | 0893-9454 | 1465-7368 | [S170137484](https://api.openalex.org/sources/S170137484) | [0893-9454](https://api.crossref.org/journals/0893-9454) |
| JCF | Journal of Corporate Finance | 金融 | 0929-1199 | 1872-6313 | [S152282257](https://api.openalex.org/sources/S152282257) | [0929-1199](https://api.crossref.org/journals/0929-1199) |
| JIBS | Journal of International Business Studies | 管理/创新/运营 | 0047-2506 | 1478-6990 | [S38024979](https://api.openalex.org/sources/S38024979) | [0047-2506](https://api.crossref.org/journals/0047-2506) |
| RP | Research Policy | 管理/创新/运营 | 0048-7333 | 1873-7625 | [S9731383](https://api.openalex.org/sources/S9731383) | [0048-7333](https://api.crossref.org/journals/0048-7333) |
| MS | Management Science | 管理/创新/运营 | 0025-1909 | 1526-5501 | [S33323087](https://api.openalex.org/sources/S33323087) | [0025-1909](https://api.crossref.org/journals/0025-1909) |
| JM | Journal of Management | 管理/创新/运营 | 0149-2063 | 1557-1211 | [S122767448](https://api.openalex.org/sources/S122767448) | [0149-2063](https://api.crossref.org/journals/0149-2063) |
| JOM | Journal of Operations Management | 管理/创新/运营 | 0272-6963 | 1873-1317 | [S142306484](https://api.openalex.org/sources/S142306484) | [0272-6963](https://api.crossref.org/journals/0272-6963) |

## 易混淆项

- JM 是 Journal of Management，不是 Journal of Marketing。
- JOM 是 Journal of Operations Management。
- RES 是 The Review of Economic Studies。
- RFS 的 OpenAlex 显示名为 Review of Financial Studies，配置保留 The Review of Financial Studies；对应 source ID 和 ISSN 一致。
- JIBS 的 Crossref 记录还返回一个未注明介质的 ISSN `0047-8210`；本配置未将其擅自当成当前印刷版或电子版。
- AOS、JAE、JFE、JCF、RP 的 Crossref 期刊记录没有提供足够的电子 ISSN 介质信息，不能声称这五项在两个 API 中都确认了 Online 身份。已补查下列原始登记机构记录。

## 电子 ISSN 的补充证据

| 期刊 | ISSN Portal 登记记录 | 登记介质 |
| --- | --- | --- |
| AOS | [1873-6289](https://portal.issn.org/resource/ISSN/1873-6289) | Online |
| JAE | [1879-1980](https://portal.issn.org/resource/ISSN/1879-1980) | Online |
| JFE | [1879-2774](https://portal.issn.org/resource/ISSN/1879-2774) | Online |
| JCF | [1872-6313](https://portal.issn.org/resource/ISSN/1872-6313) | Online |
| RP | [1873-7625](https://portal.issn.org/resource/ISSN/1873-7625) | Online |

本地 `node scripts/journals.js` 只检查配置格式、数量、ISSN校验位和唯一性，不会自动重做上述联网核验。
同一刊的印刷版和电子版共用一个内部 key；OpenAlex 回包校验 primary source ID，Crossref 回包必须包含配置中的至少一个 ISSN，避免把刊名相似的其他期刊收进来。

本轮没有把38份官方响应保存成仓库文件；保留的是核对结论、时间和可追溯链接。网络试抓情况与其限制见 [第二阶段交接说明](phase-2-report.md)。
